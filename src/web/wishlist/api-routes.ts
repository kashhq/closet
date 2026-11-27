import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { refusedBody } from '../api/refused-body';
import { goesWithCloset } from '../gallery/ideas';
import { GarmentParams, RowId } from '../schemas';
import { actorOf, authorizeWardrobe } from '../sharing/access';
import { garmentAddress } from '../wardrobe/garment-access';
import { OwnerId } from '../wardrobe/garment-api-input';
import { readPrice } from '../wardrobe/garment-input';
import { readInbox } from './inbox';
import { buyWishlistItem } from './purchase';
import {
  makeDecision,
  markNeedsSeen,
  type OwnerDecision,
  requireNeed,
} from './suggestion-actions';
import {
  DecisionMade,
  GoesWith,
  NeedDecisionInput,
  NewNeedsSeen,
  PickDecisionInput,
  PurchaseInput,
  PurchaseRecorded,
  ReturnRecorded,
  toGoesWithResource,
  toNeedDetailResource,
  toNewNeedsSeen,
  toWishlistResource,
  Wishlist,
  WishlistNeedDetail,
} from './wishlist-resource';

const WishlistQuery = Type.Object({ ownerId: OwnerId });
const NeedParams = Type.Object({ id: RowId });
const NEED_PATH = '/wishlist/needs/:id';

/** A pick's decisions without a reason, as decide() names them. */
const PICK_DECISIONS = { choose: 'choose', undo: 'undo-pick' } as const;

/** A typed note, trimmed; null when blank (as the page's). */
function noteOf(note: string | undefined): string | null {
  return note?.trim() || null;
}

/**
 * The wishlist and Muse's inbox on /api/v1 (#194b; plan section 6),
 * registered by apiPlugin, each calling what its page twin calls
 * (operations.ts names the twin): readInbox and requireNeed for the tab and
 * a need's screen, makeDecision for every decision the owner makes,
 * buyWishlistItem for "Bought it", markNeedsSeen for "New from Muse",
 * goesWithCloset for a wishlist item's "Goes with my closet". Each refuses
 * itself. The wishlist is shared like the rest of the wardrobe
 * (src/web/wishlist/AGENTS.md): a VIEW share reads it and Muse's notes, a
 * MANAGE share buys, and every decision, the unlocks and goes-with are the
 * owner's alone. A new item is POST /garments with `destination`
 * `wishlist`; "Bought a different one" is POST /garments with
 * `boughtForNeedId`. Muse's own writes stay MCP's (agentOnly).
 */
export const wishlistApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger } = options;

  app.get(
    '/wishlist',
    {
      schema: {
        operationId: 'getWishlist',
        tags: ['wishlist'],
        summary: "The wishlist, as Muse's inbox",
        description:
          "Ready to buy, Muse's needs with their options, your own items, the needs Muse is still looking for, and what was set aside. A share reads it without the unlocks (they judge the owner's closet).",
        querystring: WishlistQuery,
        response: apiResponses({ 200: Wishlist }),
      },
    },
    async (request) => {
      const { access } = await authorizeWardrobe(
        db,
        actorOf(request),
        request.query.ownerId,
        'view',
        'wardrobe',
      );
      const inbox = await readInbox(db, {
        ownerId: access.ownerId,
        viewerId: actorOf(request).userId,
        role: access.role,
      });
      logger.debug(
        `Inbox of wardrobe ${access.ownerId} (API): ${inbox.groups.length} needs with options, ${inbox.counted} options counted in ${inbox.searchMs.toFixed(0)}ms`,
      );
      return toWishlistResource(inbox);
    },
  );

  app.post(
    '/wishlist/seen',
    {
      schema: {
        operationId: 'markWishlistSeen',
        tags: ['wishlist'],
        summary: '"New from Muse": what came in since you last looked',
        description:
          'Your own inbox: answers the open needs with options suggested since the last call (every one the first time), and marks them seen, so the next call answers only newer ones.',
        response: apiResponses({ 200: NewNeedsSeen }),
      },
    },
    async (request) => {
      const needs = await markNeedsSeen({ db, logger }, actorOf(request));
      return toNewNeedsSeen(needs);
    },
  );

  app.get(
    NEED_PATH,
    {
      schema: {
        operationId: 'getWishlistNeed',
        tags: ['wishlist'],
        summary: "A need's decision screen",
        description:
          'The need, its options (for the owner each judged against the closet: the outfits it unlocks and the best of them) and those set aside. A need outside the wardrobe is a 404.',
        params: NeedParams,
        querystring: WishlistQuery,
        response: apiResponses({ 200: WishlistNeedDetail }),
      },
    },
    async (request) => {
      const { access, detail } = await requireNeed(db, actorOf(request), {
        id: request.params.id,
        ownerId: request.query.ownerId,
      });
      logger.debug(
        `Need ${detail.need.id} of wardrobe ${access.ownerId} (API): ${detail.options.length} options judged in ${detail.searchMs.toFixed(0)}ms`,
      );
      return toNeedDetailResource(detail);
    },
  );

  /** makeDecision() for the owner, which logs its own outcome. */
  function decided(
    request: FastifyRequest,
    ownerId: number | undefined,
    decision: OwnerDecision,
  ) {
    return makeDecision({ db, logger }, actorOf(request), ownerId, decision);
  }

  app.post(
    '/garments/:id/decisions',
    {
      schema: {
        operationId: 'decideWishlistPick',
        tags: ['wishlist'],
        summary: "Decides one of Muse's options",
        description:
          "This one (`choose`), Not for me (`dismiss`, with your reason) or its Undo, the owner's alone (a share is a 403). An option outside the wardrobe is a 404; a move its state does not take (a double tap, a stale screen) a 409.",
        params: GarmentParams,
        querystring: WishlistQuery,
        body: PickDecisionInput,
        response: apiResponses({ 200: DecisionMade }),
      },
    },
    async (request) => {
      const garmentId = request.params.id;
      const { body } = request;
      const decision: OwnerDecision =
        body.event === 'dismiss'
          ? {
              kind: 'dismiss-pick',
              garmentId,
              reason: body.reason,
              note: noteOf(body.note),
            }
          : { kind: PICK_DECISIONS[body.event], garmentId };
      const outcome = await decided(request, request.query.ownerId, decision);
      return {
        ...(outcome.groupId !== null && { needId: outcome.groupId }),
        setAside: outcome.dismissed,
        restored: outcome.restored,
      };
    },
  );

  app.post(
    `${NEED_PATH}/decisions`,
    {
      schema: {
        operationId: 'decideWishlistNeed',
        tags: ['wishlist'],
        summary: 'Sets a need aside, or undoes a decision on it',
        description:
          "Not this need right now (`dismiss`, with your reason), or `undo` (a need set aside, or a choice: its options back), the owner's alone. A need outside the wardrobe is a 404; a move its state does not take a 409.",
        params: NeedParams,
        querystring: WishlistQuery,
        body: NeedDecisionInput,
        response: apiResponses({ 200: DecisionMade }),
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const { body } = request;
      const decision: OwnerDecision =
        body.event === 'dismiss'
          ? {
              kind: 'dismiss-group',
              groupId,
              reason: body.reason,
              note: noteOf(body.note),
            }
          : { kind: 'undo-group', groupId };
      const outcome = await decided(request, request.query.ownerId, decision);
      return {
        needId: groupId,
        setAside: outcome.dismissed,
        restored: outcome.restored,
      };
    },
  );

  app.post(
    '/garments/:id/purchases',
    {
      schema: {
        operationId: 'buyWishlistItem',
        tags: ['wishlist'],
        summary: '"Bought it": a wishlist item into the closet',
        description:
          "With the day and the price paid, and for one of Muse's options its need settled. Your own wardrobe or a MANAGE share; `archiveReplaced` the owner's alone. A garment no longer on the wishlist (bought already: a retry) is a 409.",
        params: GarmentParams,
        querystring: WishlistQuery,
        body: PurchaseInput,
        response: apiResponses({ 200: PurchaseRecorded }),
      },
    },
    async (request) => {
      const { acquiredOn = null, archiveReplaced = false } = request.body;
      // The price as the page's form stores it ("49.9" is 49.90).
      const read = readPrice(request.body.price ?? undefined);
      if ('error' in read) {
        throw refusedBody({ price: [read.error] }, { price: '/price' });
      }
      const { price } = read;
      const actor = actorOf(request);
      const outcome = await buyWishlistItem(
        options,
        actor,
        garmentAddress(request),
        { acquiredOn, price, archiveReplaced },
      );
      return outcome.archivedReplaced === null
        ? {}
        : { archivedReplaced: outcome.archivedReplaced };
    },
  );

  app.post(
    '/garments/:id/returns',
    {
      schema: {
        operationId: 'returnGarment',
        tags: ['wishlist'],
        summary: "Returned it: one of Muse's options taken back after buying",
        description:
          "Archived and set aside as returned, its need open again: the owner's alone. A garment that is no bought option is a 409.",
        params: GarmentParams,
        querystring: WishlistQuery,
        response: apiResponses({ 200: ReturnRecorded }),
      },
    },
    async (request) => {
      const { id } = request.params;
      const outcome = await makeDecision(
        { db, logger },
        actorOf(request),
        request.query.ownerId,
        { kind: 'returned', garmentId: id },
      );
      return outcome.groupId === null ? {} : { needId: outcome.groupId };
    },
  );

  app.get(
    '/garments/:id/goes-with',
    {
      schema: {
        operationId: 'getGoesWith',
        tags: ['wishlist'],
        summary: '"Goes with my closet": one of your wishlist items judged',
        description:
          "How many outfits it makes with your closet (dirty and away included), the best few, each role it is worn with and the garments near-identical to it. The owner's alone, as on the item's page: a share naming the owner is a 403; another's item, or a garment off the wishlist, a 404.",
        params: GarmentParams,
        querystring: WishlistQuery,
        response: apiResponses({ 200: GoesWith }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      // It judges the owner's closet: a share sees the item, never this.
      await authorizeWardrobe(
        db,
        actor,
        request.query.ownerId,
        'own',
        'wishlistItem',
      );
      const started = performance.now();
      const judged = await goesWithCloset(db, actor, request.params.id);
      logger.debug(
        `Goes with my closet for garment ${request.params.id} (API): ${judged.outfits}${judged.capped ? '+' : ''} outfits in ${(performance.now() - started).toFixed(0)}ms`,
      );
      return toGoesWithResource(judged);
    },
  );

  done();
};
