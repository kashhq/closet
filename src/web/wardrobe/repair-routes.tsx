import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { sessionUserId } from '../auth/require-session';
import { todayIn } from '../../calendar-date';
import type { WebOptions } from '../plugin';
import { actorOf } from '../sharing/access';
import { garmentAddress } from './garment-access';
import { garmentToMend, logRepair, removeRepair } from './garment-actions';
import { renderGarmentForm } from './render-form';
import { REPAIRS_ANCHOR } from './repair-log';
import {
  RepairBody,
  RepairParams,
  readRepairForm,
  repairPanel,
} from './repairs';
import { garmentUrl } from './urls';
import { GarmentParams, OwnerQuery } from '../schemas';
import { storedFormValues } from './garment-input';

/**
 * The repair and alteration log's writes (#23; docs/plans/2026-09-26-
 * wardrobe-features.md, section 17), from the edit page's editor
 * (repair-log.tsx). The owner's own record, like wears (garmentToMend says
 * who is refused). Native posts: a refused entry re-renders the edit page
 * (400) with its messages.
 */
export const repairRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger },
  done,
) => {
  /** The edit page's editor, where the writes send the person back. */
  const editorUrl = (id: number) =>
    `${garmentUrl(id, undefined, '/edit')}#${REPAIRS_ANCHOR}`;

  // Logs an entry; 303 to the garment page, where the log shows it.
  app.post(
    '/wardrobe/:id/repairs',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: RepairBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const userId = sessionUserId(request);
      const actor = actorOf(request);
      const address = garmentAddress(request);
      // Read before the entry is parsed: a refused one draws the edit page.
      const { garment } = await garmentToMend(db, actor, address);
      const today = todayIn(config.timeZone, new Date());
      const form = readRepairForm(request.body, today);
      if (!form.ok) {
        logger.warn(
          `Repair for garment ${id} refused for user ${userId}: ${Object.keys(form.errors).join(', ')}`,
        );
        return renderGarmentForm(
          reply,
          db,
          {
            mode: { kind: 'edit', garmentId: id, wishlist: false },
            suggestionsFrom: userId,
            viewOwner: undefined,
            values: storedFormValues(garment, { owner: true }),
            repairs: repairPanel(garment, true, today, form),
          },
          400,
        );
      }
      await logRepair({ db, logger }, actor, address, form.entry);
      return reply.redirect(
        `${garmentUrl(id, undefined)}?repairSaved=1#${REPAIRS_ANCHOR}`,
        303,
      );
    },
  );

  // Removes an entry; 303 back to the editor.
  app.post(
    '/wardrobe/:id/repairs/:repairId/delete',
    { schema: { params: RepairParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { id, repairId } = request.params;
      await removeRepair(
        { db, logger },
        actorOf(request),
        garmentAddress(request),
        repairId,
      );
      return reply.redirect(editorUrl(id), 303);
    },
  );

  done();
};
