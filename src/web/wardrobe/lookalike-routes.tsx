import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { WebOptions } from '../plugin';
import { renderFragment } from '../render';
import { GarmentParams, OwnerQuery } from '../schemas';
import { actorOf } from '../sharing/access';
import { garmentAddress, garmentGuard } from './garment-access';
import { addGarmentCopies } from './garment-actions';
import { LookalikesContent } from './lookalike-region';
import { closetLookalikes, LookalikesQuery } from './lookalikes';
import { garmentUrl, readIdList } from './urls';

/**
 * The garment form's duplicate check (#20; docs/plans/2026-09-26-wardrobe-
 * features.md, section 18; lookalikes.ts). Both are part of adding to the
 * addressed wardrobe, so both need the owner or a MANAGE share, as
 * GET /wardrobe/new does; a clone's check addresses the requester's own.
 */
export const lookalikeRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, logger },
  done,
) => {
  const authorize = garmentGuard(db);
  // The region's contents for the form's current fields: a read, always a
  // fragment. The dismissed list is navigation state (malformed ids are
  // dropped); a field past the form's caps is a 400 like the form's own.
  app.get(
    '/wardrobe/lookalikes',
    { schema: { querystring: LookalikesQuery } },
    async (request, reply) => {
      const { query } = request;
      const { access, viewOwner } = await authorize(request, 'manage');
      const dismissed = readIdList(query.lookalikesDismissed);
      const matches = await closetLookalikes(
        db,
        access.ownerId,
        {
          category: query.category ?? '',
          type: query.type ?? '',
          colors: query.color ?? [],
          brand: query.brand ?? '',
        },
        { dismissed },
      );
      if (matches.length > 0) {
        logger.debug(
          `Lookalikes for a new garment in wardrobe ${access.ownerId}: ${matches.map((m) => m.id).join(', ')}${dismissed.length > 0 ? ` (${dismissed.length} dismissed)` : ''}`,
        );
      }
      return renderFragment(
        reply,
        <LookalikesContent panel={{ matches, dismissed, viewOwner }} />,
      );
    },
  );

  // "Add a copy": one more of the closet garment instead of a new garment
  // (addGarmentCopies); 303 to its page with a toast. A native post from
  // the form's LookalikeCopyForm: a refusal is the error page (a garment
  // archived or moved meanwhile is a 409, past the cap too).
  app.post(
    '/wardrobe/:id/copies',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { id } = request.params;
      const { viewOwner } = await addGarmentCopies(
        { db, logger },
        actorOf(request),
        garmentAddress(request),
        1,
      );
      return reply.redirect(
        garmentUrl(id, viewOwner, '', { copyAdded: 1 }),
        303,
      );
    },
  );

  done();
};
