import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { CloneType, Type } from '@sinclair/typebox';
import { todayIn } from '../../calendar-date';
import { REPLAY_WINDOW_DAYS } from '../../offline-writes';
import { DEFAULT_OCCASION, OCCASIONS } from '../../wardrobe/occasions';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { literals } from '../api/resource';
import { dayOutsideWindow } from '../offline-writes';
import { IsoDateSchema, RowId } from '../schemas';
import { actorOf } from '../sharing/access';
import { rainGearForDays } from '../weather/queries';
import { MAX_WORN_GARMENTS } from './queries';
import { wearIdeaOn } from './today-actions';
import { todayFor } from './today';
import { TodayResource, toTodayResource } from './today-resource';

const OutfitWearInput = Type.Object(
  {
    garmentIds: Type.Array(RowId, {
      minItems: 1,
      maxItems: MAX_WORN_GARMENTS,
      description:
        "Your closet's garments, as an idea holds them: the outfit of exactly these is reused, else saved. One not in your closet is a 404 (a 409 naming those archived or not bought yet), nothing written",
    }),
    occasion: literals(OCCASIONS),
    day: CloneType(IsoDateSchema, {
      description: `The household day it was worn (GET /me's \`today\`), at most ${REPLAY_WINDOW_DAYS} days back; another is a 409`,
    }),
  },
  {
    title: 'OutfitWear',
    description:
      'Today\'s "Wear this": the garments worn together that day for an occasion',
  },
);

const OutfitWorn = Type.Object(
  {
    outfitId: Type.Integer(),
    /** The garments were an outfit of yours already. */
    alreadySaved: Type.Boolean(),
    /** Its calendar entry that day, marked worn. */
    entryId: Type.Integer(),
    /** False when it was worn that day already: a retry. */
    changed: Type.Boolean(),
    wears: Type.Integer({
      minimum: 0,
      description: 'Garment wears logged by this request',
    }),
  },
  {
    title: 'OutfitWorn',
    description:
      'The outfit and its entry on the day, worn: the calendar is the one history of what was worn when',
  },
);

/**
 * Today on /api/v1 (plan section 6): GET /today (#195a), the page's model
 * (todayFor) in the page's statements, and "Wear this" (#193b), the page's
 * wearIdea in one owner transaction (pickIdea, then wearOutfitOn). Its
 * Refresh is GET /ideas with the row's cursor, the same seeded read; "Wore
 * it" and Change are the calendar entry's routes. The token's user's own
 * day, like the page: there is no `?ownerId=`. A wear's day is sent, as
 * every API wear's is (plan section 2), and judged by the queued taps'
 * window.
 */
export const todayApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, config, logger, weather },
  done,
) => {
  const deps = { db, weather, timeZone: config.timeZone };

  app.get(
    '/today',
    {
      schema: {
        operationId: 'getToday',
        tags: ['calendar'],
        summary: 'Today, as the home screen shows it',
        description:
          "The household's day (GET /me's `today`): your weather, Muse's card, and a row per part of the day. A row per occasion planned today with its entries (Wore it: PUT /calendar-entries/{id}/worn; Change: PUT /calendar-entries/{id}/outfit); while nothing that dresses the day (all day, work, daytime) is planned, an all-day row of ideas first. No ETag: it moves with the day and the forecast.",
        response: apiResponses({ 200: TodayResource }),
      },
    },
    async (request) => {
      const ownerId = actorOf(request).userId;
      const started = performance.now();
      const model = await todayFor(deps, ownerId, new Date(), {
        needs: true,
      });
      logger.debug(
        `Today for user ${ownerId} (${model.today}) (API): ${model.rows.length} row(s) in ${Math.round(performance.now() - started)} ms`,
      );
      const rainGear = await rainGearForDays(deps.db, ownerId, model.weather, [
        { day: model.today, occasion: DEFAULT_OCCASION },
      ]);
      return toTodayResource(model, rainGear);
    },
  );
  app.post(
    '/outfit-wears',
    {
      schema: {
        operationId: 'wearOutfit',
        tags: ['calendar'],
        summary: 'Wore these garments together that day',
        description:
          'Saves them as an outfit (or finds the one they are), plans it that day for the occasion and marks it worn, in one transaction. Once: a retry finds the outfit and its entry worn (`changed: false`). The outfit already on that day keeps its entry and its occasion.',
        body: OutfitWearInput,
        response: apiResponses({ 200: OutfitWorn }),
      },
    },
    async (request) => {
      const { garmentIds, occasion, day } = request.body;
      const now = new Date();
      const today = todayIn(config.timeZone, now);
      const refusal = dayOutsideWindow(day, today);
      if (refusal) throw refusal;
      const { outfit, entryId, worn } = await wearIdeaOn(
        { db, logger },
        actorOf(request),
        { garmentIds, occasion, day, today, at: now },
      );
      return {
        outfitId: outfit.id,
        alreadySaved: outfit.alreadySaved,
        entryId,
        changed: worn.changed,
        wears: worn.wears,
      };
    },
  );

  done();
};
