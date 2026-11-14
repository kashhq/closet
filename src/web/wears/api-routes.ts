import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { CloneType, Type } from '@sinclair/typebox';
import { type IsoDate, todayIn } from '../../calendar-date';
import { AWAY_REASONS } from '../../wardrobe/availability';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { literals, Nullable, withoutNulls } from '../api/resource';
import { dayOutsideWindow, postedInstant } from '../offline-writes';
import { REPLAY_WINDOW_DAYS } from '../../offline-writes';
import { IsoDateSchema, RowId, TapInstantSchema } from '../schemas';
import { actorOf } from '../sharing/access';
import { garmentAddress } from '../wardrobe/garment-access';
import { GarmentQuery } from '../wardrobe/garment-api-input';
import { CARE_NOTE_MAX } from '../wardrobe/garment-input';
import {
  putGarmentAway,
  washGarment,
  washGarments,
  wearGarment,
} from './wear-actions';

/** The days a wear or wash may be for: what a phone offline for a week still sends. */
const WriteDay = CloneType(IsoDateSchema, {
  description: `The household day it happened (GET /me's \`today\`), at most ${REPLAY_WINDOW_DAYS} days back; another is a 409`,
});

const WearParams = Type.Object({ id: RowId, day: WriteDay });

/** When it happened (#676): orders a wear and a wash of the same day. */
const WriteInstant = CloneType(TapInstantSchema, {
  description:
    'When it happened, with its offset; default now. Orders a wear and a wash of the same day (worn after the morning wash counts toward the next); one after now is taken as now, one outside `day` is dropped (the day rule: a wear that day counts before its wash)',
});

const WearBody = Type.Union([
  Type.Object({
    clientId: Type.Optional(
      Type.String({
        format: 'uuid',
        description:
          'Your id for this wear, for retrying it offline: accepted, not yet stored (a wear is once a garment a day anyway)',
      }),
    ),
    at: Type.Optional(WriteInstant),
  }),
  Type.Null(),
]);

const Worn = Type.Object(
  {
    day: IsoDateSchema,
    worn: Type.Boolean(),
    /** False when it already was so: a retry. */
    changed: Type.Boolean(),
  },
  { title: 'GarmentWear', description: "The garment's own wear that day" },
);

const WashInput = Type.Object(
  { day: WriteDay, at: Type.Optional(WriteInstant) },
  { title: 'GarmentWash' },
);

const Washed = Type.Object(
  {
    day: IsoDateSchema,
    /** False when it was washed that day or later already: a wash never moves back. */
    changed: Type.Boolean(),
  },
  { title: 'GarmentWashed' },
);

const LaundryInput = Type.Object(
  {
    garmentIds: Type.Array(RowId, { minItems: 1, maxItems: 2000 }),
    day: WriteDay,
    at: Type.Optional(WriteInstant),
  },
  {
    title: 'LaundryWash',
    description:
      "Laundry day: every copy of each garment washed. Ids that are not your garments' (or wishlist items) are left out of the answer, never an error",
  },
);

const LaundryWashed = Type.Object(
  {
    washed: Type.Array(Type.Integer(), {
      description:
        'The garments washed (those already washed then or later included)',
    }),
  },
  { title: 'LaundryWashed' },
);

const AwayInput = Type.Object(
  {
    away: Type.Union([literals(AWAY_REASONS), Type.Null()], {
      description: 'Lent, or at the repair shop; null is back in the closet',
    }),
    note: Nullable(Type.String({ maxLength: CARE_NOTE_MAX }), {
      description: 'Who has it, or which shop: kept only while away',
    }),
  },
  { title: 'GarmentAway' },
);

const Away = Type.Object(
  {
    away: Type.Optional(literals(AWAY_REASONS)),
    note: Type.Optional(Type.String()),
  },
  {
    title: 'GarmentWhereabouts',
    description: 'Where the garment is: no `away`, in the closet',
  },
);

/**
 * Wears, washes and away on /api/v1 (#193a; plan section 6), registered by
 * apiPlugin, each calling what its page twin calls (wear-actions.ts, the
 * laundry's markWashed). The owner's own records: a grantee who sees the
 * garment is a 403 through `?ownerId=`, a 404 without it, and the laundry
 * is always the token's user's. Every wear and wash names its day (plan
 * section 2), judged by the window the page's queued taps keep, and is
 * set-state, so a retry changes nothing.
 */
export const wearApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, config, logger },
  done,
) => {
  const deps = { db, logger };
  /** The day sent, or the 409 a day outside the window is. */
  function judgedDay(day: IsoDate): IsoDate {
    const refusal = dayOutsideWindow(day, todayIn(config.timeZone, new Date()));
    if (refusal) throw refusal;
    return day;
  }

  const WEAR_PATH = '/garments/:id/wears/:day';

  app.put(
    WEAR_PATH,
    {
      schema: {
        operationId: 'wearGarment',
        tags: ['wears'],
        summary: 'Wore it that day',
        description:
          "Wore today, for a day of the last week: the garment's own wear, apart from an outfit's (a calendar entry marked worn). Once a day: a repeat is `changed: false`. Your own garments only; a wishlist item is a 409.",
        params: WearParams,
        querystring: GarmentQuery,
        body: WearBody,
        response: apiResponses({ 200: Worn }),
      },
    },
    async (request) => {
      const day = judgedDay(request.params.day);
      const { changed } = await wearGarment(
        deps,
        actorOf(request),
        garmentAddress(request),
        {
          day,
          worn: true,
          clientId: request.body?.clientId,
          wornAt: postedInstant(
            request,
            request.body?.at,
            day,
            config.timeZone,
          ),
        },
      );
      return { day, worn: true, changed };
    },
  );

  app.delete(
    WEAR_PATH,
    {
      schema: {
        operationId: 'unwearGarment',
        tags: ['wears'],
        summary: "Undoes that day's wear",
        description:
          "Only the garment's own wear that day: an outfit's wear is undone on its calendar entry. None that day is `changed: false`.",
        params: WearParams,
        querystring: GarmentQuery,
        response: apiResponses({ 200: Worn }),
      },
    },
    async (request) => {
      const day = judgedDay(request.params.day);
      const { changed } = await wearGarment(
        deps,
        actorOf(request),
        garmentAddress(request),
        { day, worn: false, wornAt: null },
      );
      return { day, worn: false, changed };
    },
  );

  app.post(
    '/garments/:id/washes',
    {
      schema: {
        operationId: 'washGarment',
        tags: ['wears'],
        summary: 'Washed it that day',
        description:
          'Every copy, clean from that day: wears that day count as before the wash. A wash never moves back, so an older one than the last is `changed: false`. Your own garments only; a wishlist item is a 409.',
        params: Type.Object({ id: RowId }),
        querystring: GarmentQuery,
        body: WashInput,
        response: apiResponses({ 200: Washed }),
      },
    },
    async (request) => {
      const day = judgedDay(request.body.day);
      const at = postedInstant(request, request.body.at, day, config.timeZone);
      const { changed } = await washGarment(
        deps,
        actorOf(request),
        garmentAddress(request),
        { day, at },
      );
      return { day, changed };
    },
  );

  app.post(
    '/garments/washes',
    {
      schema: {
        operationId: 'washGarments',
        tags: ['wears'],
        summary: 'Laundry day: washes many garments',
        description:
          'The laundry\'s "Mark washed". GET /garments?needsWash=true lists what needs one. Always your own garments, whatever is shared with you.',
        body: LaundryInput,
        response: apiResponses({ 200: LaundryWashed }),
      },
    },
    async (request) => {
      const { garmentIds } = request.body;
      const day = judgedDay(request.body.day);
      const washed = await washGarments(deps, actorOf(request), garmentIds, {
        day,
        at: postedInstant(request, request.body.at, day, config.timeZone),
      });
      return { washed: washed.map((row) => row.id) };
    },
  );

  app.put(
    '/garments/:id/away',
    {
      schema: {
        operationId: 'setGarmentAway',
        tags: ['wears'],
        summary: 'Says where a garment is: lent, at the repair shop, or back',
        description:
          'Away, it is never suggested or packed. Set-state: a repeat changes nothing. Your own garments only; a wishlist item is a 409.',
        params: Type.Object({ id: RowId }),
        querystring: GarmentQuery,
        body: AwayInput,
        response: apiResponses({ 200: Away }),
      },
    },
    async (request) => {
      const { away, note } = request.body;
      const stored =
        away === null ? null : { reason: away, note: note?.trim() || null };
      await putGarmentAway(
        deps,
        actorOf(request),
        garmentAddress(request),
        stored,
      );
      return withoutNulls({
        away: stored?.reason ?? null,
        note: stored?.note ?? null,
      });
    },
  );

  done();
};
