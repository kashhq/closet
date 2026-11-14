import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { todayIn } from '../../calendar-date';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { outfitText } from '../outfits/queries';
import { actorOf } from '../sharing/access';
import { API_PREFIX } from '../surface';
import {
  askedIdeas,
  ClashParams,
  ClashSet,
  IDEAS_DEPTH,
  IdeaList,
  IdeaQuery,
  ideasNote,
  OutfitPicked,
  OutfitPickInput,
  pickDestinationOf,
  toIdeaList,
  toOutfitPicked,
} from './idea-resource';
import { ideasWith } from './ideas';
import { pickGarments } from './pick';
import { allowGarmentPair, avoidGarmentPair } from './pair-actions';
import { BY_PERSON } from '../write-origin';

const CLASH_PATH = '/garments/:id/clashes/:otherId';

/**
 * The outfit gallery on /api/v1 (#193c; plan section 6), registered by
 * apiPlugin, each calling what its page twin calls (operations.ts names the
 * twin): ideasFor's statement (ideasWith) for the Ideas tab and Styling's
 * Shuffle, pickGarments for a card's pick and Styling's Save of a new
 * outfit, avoidGarmentPair and allowGarmentPair for "Clashes" and "Allow again". Ideas
 * are private like outfits (AGENTS.md): the token's user's own closet,
 * capsules and outfits; there is no `?ownerId=`, and a garment or capsule
 * of anyone else's is the 404 of an unknown id.
 */
export const galleryApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, config, logger, weather },
  done,
) => {
  app.get(
    '/ideas',
    {
      schema: {
        operationId: 'listIdeas',
        tags: ['ideas'],
        summary: 'Outfit ideas from your closet for a day and an occasion',
        description: `The Ideas tab's cards, and Styling's Shuffle (its locked rows in \`with\`, one idea: \`limit=1\`, another \`seed\` per shuffle). Each says what is off about it, if anything. At most ${IDEAS_DEPTH} ideas deep; a \`cursor\` carries the seed, so send the same day, occasion, capsule and garments with it. Save one with POST /outfit-picks.`,
        querystring: IdeaQuery,
        response: apiResponses({ 200: IdeaList }),
      },
    },
    async (request) => {
      const ownerId = actorOf(request).userId;
      const now = new Date();
      const asked = askedIdeas(request.query, todayIn(config.timeZone, now));
      const started = performance.now();
      const result = await ideasWith({ db, weather }, ownerId, asked, now);
      logger.debug(
        `Ideas for user ${ownerId} (API): ${ideasNote(asked, result)} in ${Math.round(performance.now() - started)} ms`,
      );
      return toIdeaList(asked, result);
    },
  );

  app.post(
    '/outfit-picks',
    {
      schema: {
        operationId: 'pickOutfit',
        tags: ['ideas'],
        summary: "Saves an idea's garments as an outfit",
        description:
          "A card's pick, and Styling's Save of a new outfit: one transaction, once. Garments that are an outfit of yours already answer that one, 200 with `alreadySaved` (and planned when asked), so a retry creates nothing; a new one is 201 with its `Location`. Choosing Plan my week's outfit or entry makes it yours.",
        body: OutfitPickInput,
        response: apiResponses({ 200: OutfitPicked, 201: OutfitPicked }),
      },
    },
    async (request, reply) => {
      const { garmentIds, name, clientId } = request.body;
      const client = clientId ? `, client id ${clientId.slice(0, 8)}` : '';
      const picked = await pickGarments(
        { db, logger },
        actorOf(request),
        pickDestinationOf(request.body),
        garmentIds,
        {
          source: 'idea',
          name: outfitText(name) ?? undefined,
          via: ` (API${client})`,
          madeBy: BY_PERSON,
        },
      );
      const { outfit } = picked;
      if (outfit.alreadySaved) return toOutfitPicked(outfit);
      return reply
        .status(201)
        .header('Location', `${API_PREFIX}/outfits/${outfit.id}`)
        .send(toOutfitPicked(outfit));
    },
  );

  app.put(
    CLASH_PATH,
    {
      schema: {
        operationId: 'avoidGarmentPair',
        tags: ['ideas'],
        summary: 'Says two of your garments clash',
        description:
          'The Ideas card\'s "Clashes": no idea pairs them again (Plan my week neither). Set-state: a pair avoided already is `changed: false`. A garment not yours, or the same one twice, is a 404.',
        params: ClashParams,
        response: apiResponses({ 200: ClashSet }),
      },
    },
    async (request) => {
      const { id, otherId } = request.params;
      return avoidGarmentPair({ db, logger }, actorOf(request), id, otherId);
    },
  );

  app.delete(
    CLASH_PATH,
    {
      schema: {
        operationId: 'allowGarmentPair',
        tags: ['ideas'],
        summary: 'Lets two garments be paired again',
        description:
          '"Allow again", the undo of PUT. A pair you never avoided is a 404, which a retry may read as done.',
        params: ClashParams,
        response: apiResponses({ 204: Type.Null({ description: 'Allowed' }) }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id, otherId } = request.params;
      await allowGarmentPair({ db, logger }, actor, id, otherId);
      return reply.status(204).send(null);
    },
  );

  done();
};
