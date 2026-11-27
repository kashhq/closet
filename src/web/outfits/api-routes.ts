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
import { PublicShare, publicShareUrl } from '../share/urls';
import { API_PREFIX } from '../surface';
import {
  editOutfit,
  saveOutfit,
  reactToProposal,
  removeOutfit,
  requireOutfitPage,
  setOutfitPublicShare,
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
import { listOutfitsPage, outfitText } from './queries';
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
        "`true`: your agent's proposals waiting on you (the Outfits tab's From the agent cards) instead of your own outfits; each carries its `proposal`",
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
 * outfit-actions.ts for one outfit, saveOutfit for a new one. Outfits are
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
          'Each with its garments in the order it was built and the pieces still to buy. The agent’s proposals you have not made yours are not listed: `proposed=true` lists the ones waiting on you instead (set-aside ones stay out).',
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
        config.siteUrl,
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
      const { name, notes, slots, plan, clientId } = request.body;
      if (slots.every((slot) => slot.garmentId === undefined)) {
        throw new HttpError(400, t('api.OUTFIT_NEEDS_GARMENT'));
      }
      const saved = await saveOutfit(
        { db, logger },
        actorOf(request),
        {
          name: outfitText(name) ?? null,
          notes: outfitText(notes) ?? null,
          slots: slotsOf(slots),
          plan: plan && {
            day: plan.day,
            occasion: plan.occasion ?? DEFAULT_OCCASION,
          },
          origin: 'person',
          madeBy: BY_PERSON,
        },
        clientId,
      );
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
      const saved = await editOutfit({ db, logger }, actor, id, {
        name: outfitText(name),
        notes: outfitText(notes),
        slots: slots && slotsOf(slots),
      });
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
      await removeOutfit({ db, logger }, actor, id);
      return reply.status(204).send(null);
    },
  );

  // The page's Share and Stop sharing (#669, #959): one writer,
  // setOutfitPublicShare, so both are idempotent as there.
  app.put(
    `${OUTFIT_PATH}/share`,
    {
      schema: {
        operationId: 'shareOutfit',
        tags: ['outfits'],
        summary: "Makes an outfit's public link",
        description:
          "Another's outfit is a 404 like an unknown id. An outfit shared already keeps its link, answered again; one shared after a stop gets a new one, never the old.",
        params: OutfitParams,
        response: apiResponses({ 200: PublicShare }),
      },
    },
    async (request) => {
      const { shareableId } = await setOutfitPublicShare(
        { db, logger },
        actorOf(request),
        request.params.id,
        true,
      );
      return {
        publicShareUrl: publicShareUrl(config.siteUrl, 'outfit', shareableId),
      };
    },
  );

  app.delete(
    `${OUTFIT_PATH}/share`,
    {
      schema: {
        operationId: 'stopSharingOutfit',
        tags: ['outfits'],
        summary: "Ends an outfit's public link",
        description:
          'Its page and preview image are a 404 from then on. An outfit not shared is answered the same: nothing to end.',
        params: OutfitParams,
        response: apiResponses({
          204: Type.Null({ description: 'Not shared' }),
        }),
      },
    },
    async (request, reply) => {
      await setOutfitPublicShare(
        { db, logger },
        actorOf(request),
        request.params.id,
        false,
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
        { db, logger },
        actor,
        id,
        change,
      );
      return { from, to, complete };
    },
  );

  done();
};
