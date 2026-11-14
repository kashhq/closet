import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { CloneType, Type } from '@sinclair/typebox';
import { todayIn } from '../../calendar-date';
import { DEFAULT_OCCASION } from '../../wardrobe/occasions';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import {
  idCursor,
  ListCursor,
  ListLimit,
  ListOf,
  literals,
  readIdCursor,
} from '../api/resource';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { actorOf } from '../sharing/access';
import { API_PREFIX } from '../surface';
import {
  editOutfit,
  reactToProposal,
  removeOutfit,
  requireOutfitPage,
} from './outfit-actions';
import {
  NewOutfit,
  Outfit,
  OutfitListItem,
  OutfitPatch,
  OutfitReacted,
  OutfitReactionInput,
  OutfitSaved,
  OutfitUpdated,
  slotsOf,
  toOutfitListItem,
  toOutfitResource,
} from './outfit-resource';
import { OUTFIT_LISTS } from './outfit-list';
import { createOutfit, listOutfitsPage, outfitText } from './queries';
import type { OutfitReaction } from './reactions';
import { OUTFIT_PAGE_SIZE } from './page-size';
import { OutfitParams } from './schemas';
import { BY_PERSON } from '../write-origin';

const OutfitListQuery = Type.Object({
  cursor: Type.Optional(ListCursor),
  limit: ListLimit(OUTFIT_PAGE_SIZE),
  proposed: Type.Optional(
    Type.Boolean({
      description:
        "`true`: your agent's proposals waiting on you (the Outfits tab's From Muse cards) instead of your own outfits; each carries its `proposal`",
    }),
  ),
  show: Type.Optional(
    CloneType(literals(OUTFIT_LISTS), {
      description:
        "The Saved tab's lists: `kept` (origin `person` or `agent`, what Saved shows) or `one-offs` (`idea`, `planner`: Worn and planned). Absent: every outfit",
    }),
  ),
});

const OutfitList = ListOf(OutfitListItem, {
  title: 'OutfitList',
  description:
    'A page of your outfits, newest first (not those your agent proposed that are not yours yet), or with `proposed=true` of those proposals',
});

const OUTFIT_PATH = '/outfits/:id';

/**
 * Outfits on /api/v1 (#193a; plan section 6), registered by apiPlugin,
 * each calling what its page twin calls (operations.ts names the twin):
 * outfit-actions.ts for one outfit, createOutfit for a new one. Outfits are
 * private (AGENTS.md): only the token's user's own are reached, there is
 * no `?ownerId=`, and another's outfit is the 404 of an unknown id.
 */
export const outfitApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, config, logger },
  done,
) => {
  app.get(
    '/outfits',
    {
      schema: {
        operationId: 'listOutfits',
        tags: ['outfits'],
        summary: 'Your outfits, newest first',
        description:
          "Each with its garments in the order it was built and the pieces still to buy. Muse's proposals you have not made yours are not listed: `proposed=true` lists the ones waiting on you instead (set-aside ones stay out).",
        querystring: OutfitListQuery,
        response: apiResponses({ 200: OutfitList }),
      },
    },
    async (request) => {
      const {
        cursor,
        limit = OUTFIT_PAGE_SIZE,
        proposed,
        show,
      } = request.query;
      const { outfits, next } = await listOutfitsPage(
        db,
        actorOf(request).userId,
        {
          before: cursor === undefined ? undefined : readIdCursor(cursor),
          limit,
          proposed: proposed === true,
          list: show,
        },
      );
      return {
        data: outfits.map(toOutfitListItem),
        pagination: {
          ...(next !== null && { nextCursor: idCursor(next) }),
          limit,
        },
      };
    },
  );

  app.get(
    OUTFIT_PATH,
    {
      schema: {
        operationId: 'getOutfit',
        tags: ['outfits'],
        summary: 'One of your outfits, with its days',
        description:
          "Its garments (each piece away marked), the days it is planned from today on and the days it was worn. Another's outfit is a 404 like an unknown id.",
        params: OutfitParams,
        response: apiResponses({ 200: Outfit }),
      },
    },
    async (request) =>
      toOutfitResource(
        await requireOutfitPage(
          db,
          actorOf(request),
          request.params.id,
          todayIn(config.timeZone, new Date()),
        ),
      ),
  );

  app.post(
    '/outfits',
    {
      schema: {
        operationId: 'createOutfit',
        tags: ['outfits'],
        summary: 'Saves an outfit of your garments',
        description:
          'Once per garment set: garments that are an outfit of yours already answer that one, 200 with `alreadySaved` (planned too when a `plan` is given), so a retry creates nothing. A new one is 201 with its `Location`.',
        body: NewOutfit,
        response: apiResponses({ 200: OutfitSaved, 201: OutfitSaved }),
      },
    },
    async (request, reply) => {
      const userId = actorOf(request).userId;
      const { name, notes, slots, plan, clientId } = request.body;
      if (slots.every((slot) => slot.garmentId === undefined)) {
        throw new HttpError(400, t('api.OUTFIT_NEEDS_GARMENT'));
      }
      const saved = await createOutfit(db, userId, {
        name: outfitText(name) ?? null,
        notes: outfitText(notes) ?? null,
        slots: slotsOf(slots),
        plan: plan && {
          day: plan.day,
          occasion: plan.occasion ?? DEFAULT_OCCASION,
        },
        origin: 'person',
        madeBy: BY_PERSON,
      });
      const planned = plan ? `, ${saved.schedule} on ${plan.day}` : '';
      const client = clientId ? `, client id ${clientId.slice(0, 8)}` : '';
      if (saved.alreadySaved) {
        logger.info(
          `Outfit ${saved.id} of the same garments reused by user ${userId} (API)${planned}${saved.adopted ? '; taken over from the week planner' : ''}${client}`,
        );
      } else {
        logger.info(
          `Outfit ${saved.id} created by user ${userId} (API): ${saved.slots} row(s)${planned}${client}`,
        );
      }
      const answer = {
        id: saved.id,
        alreadySaved: saved.alreadySaved,
        schedule: saved.schedule,
      };
      if (saved.alreadySaved) return answer;
      return reply
        .status(201)
        .header('Location', `${API_PREFIX}/outfits/${saved.id}`)
        .send(answer);
    },
  );

  app.patch(
    OUTFIT_PATH,
    {
      schema: {
        operationId: 'updateOutfit',
        tags: ['outfits'],
        summary: "Changes an outfit's name, notes or rows",
        description:
          "Only what is sent: `slots` replaces every row. It may leave the outfit with the garments of another (an edit is not a save). Planning is the calendar's.",
        params: OutfitParams,
        body: OutfitPatch,
        response: apiResponses({ 200: OutfitUpdated }),
      },
    },
    async (request) => {
      const { id } = request.params;
      const actor = actorOf(request);
      const { name, notes, slots } = request.body;
      const saved = await editOutfit(db, actor, id, {
        name: outfitText(name),
        notes: outfitText(notes),
        slots: slots && slotsOf(slots),
      });
      const changed = [
        ...(name !== undefined ? ['name'] : []),
        ...(notes !== undefined ? ['notes'] : []),
        ...(slots ? [`${saved.slots} row(s)`] : []),
      ];
      logger.info(
        `Outfit ${id} updated by user ${actor.userId} (API): ${changed.join(', ') || 'nothing sent'}${saved.entriesClaimed ? `, ${saved.entriesClaimed} planned entry(ies) now the user's` : ''}`,
      );
      return { entriesClaimed: saved.entriesClaimed ?? 0 };
    },
  );

  app.delete(
    OUTFIT_PATH,
    {
      schema: {
        operationId: 'deleteOutfit',
        tags: ['outfits'],
        summary: 'Deletes an outfit',
        description:
          "The days it was worn stay (each piece's wear kept on its day), and so do its selfies, as looks. One of your agent's proposals not loved is a 409: decline it instead. An outfit already gone is a 404, which a retry may read as done.",
        params: OutfitParams,
        response: apiResponses({ 204: Type.Null({ description: 'Deleted' }) }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const actor = actorOf(request);
      const { wearsKept } = await removeOutfit(db, actor, id);
      logger.info(
        `Outfit ${id} deleted by user ${actor.userId} (${wearsKept} wears kept as day-level wears) (API)`,
      );
      return reply.status(204).send(null);
    },
  );

  app.post(
    `${OUTFIT_PATH}/reactions`,
    {
      schema: {
        operationId: 'reactToOutfit',
        tags: ['outfits'],
        summary: 'Reacts to an outfit your agent proposed',
        description:
          "The Outfits tab's Love, Not for me and its Undo. An outfit your agent did not propose is a 404; one that is yours already, or a move its reaction does not take (a double tap), a 409.",
        params: OutfitParams,
        body: OutfitReactionInput,
        response: apiResponses({ 200: OutfitReacted }),
      },
    },
    async (request) => {
      const { id } = request.params;
      const actor = actorOf(request);
      const { body } = request;
      const change: OutfitReaction =
        body.event === 'decline'
          ? {
              event: 'decline',
              reason: body.reason,
              note: body.note?.trim() || null,
            }
          : { event: body.event };
      const { from, to, complete } = await reactToProposal(
        db,
        actor,
        id,
        change,
      );
      logger.info(
        `Outfit ${id} ${from} -> ${to} by user ${actor.userId}${change.event === 'decline' ? ` (${change.reason})` : ''} (API)`,
      );
      return { from, to, complete };
    },
  );

  done();
};
