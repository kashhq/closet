import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { CloneType, type Static, Type } from '@sinclair/typebox';
import { DAY_OCCASIONS, OCCASIONS } from '../../wardrobe/occasions';
import {
  AROUND_OCCASIONS,
  type TemplateDay,
  templateSlots,
  WEEKDAYS,
} from '../../wardrobe/week';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { literals, Nullable, withoutNulls } from '../api/resource';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { IsoDateSchema, RowId } from '../schemas';
import { actorOf } from '../sharing/access';
import type { PlannedEntry } from './plan';
import {
  planWeekFor,
  saveWeekTemplateFor,
  undoWeekPlanFor,
} from './plan-actions';
import { findWeekTemplate } from './template';
import { toWeekTemplate, WeekTemplate } from './week-template-resource';

const Occasion = literals(OCCASIONS);

const Slot = Type.Object(
  { day: IsoDateSchema, occasion: Occasion },
  { title: 'WeekSlot' },
);

const PlannedEntryResource = Type.Object(
  {
    entryId: Type.Integer(),
    day: IsoDateSchema,
    occasion: Occasion,
    outfit: Type.Object(
      { id: Type.Integer(), name: Type.Optional(Type.String()) },
      { title: 'WeekPlannedOutfit' },
    ),
    alreadySaved: Type.Boolean({
      description: 'An outfit of yours it planned (it saved none)',
    }),
    garments: Type.Array(
      Type.Object(
        {
          id: Type.Integer(),
          name: Type.Optional(Type.String()),
          category: Type.String(),
        },
        { title: 'WeekPlannedGarment' },
      ),
    ),
    problems: Type.Array(Type.String(), {
      description:
        "A near miss taken for want of better: the weather's (`too-cold`, `needs-layer`, ...) or the occasion's (`too-casual`, `too-dressy`), or `breaks-rule`",
    }),
  },
  { title: 'WeekPlannedEntry' },
);

function toPlannedEntry(entry: PlannedEntry) {
  return {
    entryId: entry.entryId,
    day: entry.day,
    occasion: entry.occasion,
    outfit: withoutNulls({ id: entry.outfitId, name: entry.outfitName }),
    alreadySaved: entry.alreadySaved,
    garments: entry.garments.map(withoutNulls),
    problems: entry.problems,
  };
}

const WeekPlanned = Type.Object(
  {
    from: CloneType(IsoDateSchema, {
      description: 'Today: the plan covers it and the six days after',
    }),
    templateSet: Type.Boolean({
      description:
        'False: you have no week template (PUT /week-template), so nothing was planned',
    }),
    weekPlanId: Type.Optional(
      Type.Integer({
        description:
          'This plan, for its undo (DELETE /week-plans/{id}); absent when nothing new was planned',
      }),
    ),
    planned: Type.Array(PlannedEntryResource),
    unfilled: Type.Array(Slot, {
      description: 'Empty slots nothing clean could dress',
    }),
    away: Type.Array(IsoDateSchema, {
      description:
        'The days a trip covers: skipped, since a trip plans its own outfits',
    }),
    weatherDays: Type.Integer({
      minimum: 0,
      description: 'The days a forecast dressed (0 with the weather off)',
    }),
  },
  {
    title: 'WeekPlanned',
    description:
      'What Plan my week planned: entries marked `auto`, which the daily re-plan may swap until you change, wear or plan them yourself',
  },
);

const WeekPlanUndone = Type.Object(
  {
    entriesRemoved: Type.Integer({ minimum: 0 }),
    outfitsRemoved: Type.Integer({
      minimum: 0,
      description: 'Outfits the plan had made for them, held by nothing else',
    }),
  },
  { title: 'WeekPlanUndone' },
);

const TemplateDayInput = Type.Object(
  {
    weekday: CloneType(literals(WEEKDAYS), {
      description: '0 is Sunday … 6 Saturday',
    }),
    day: Nullable(literals(DAY_OCCASIONS), {
      description:
        "The day's outfit: all day, work or daytime; null or absent, none",
    }),
    around: Type.Optional(
      Type.Array(literals(AROUND_OCCASIONS), {
        maxItems: AROUND_OCCASIONS.length,
        description: 'The occasions around it; absent, none',
      }),
    ),
  },
  { title: 'WeekTemplateDayInput' },
);

const WeekTemplateInput = Type.Object(
  {
    days: Type.Array(TemplateDayInput, {
      maxItems: WEEKDAYS.length,
      description:
        'Each weekday at most once (else a 400); one not sent is empty',
    }),
  },
  {
    title: 'WeekTemplateInput',
    description:
      'Your whole week, replaced: what the Profile\'s "Your week" saves',
  },
);

/** The posted days as the template's, a weekday sent twice refused. */
function templateDaysOf(
  days: Static<typeof WeekTemplateInput>['days'],
): TemplateDay[] {
  if (new Set(days.map((d) => d.weekday)).size !== days.length) {
    throw new HttpError(400, t('api.WEEKDAY_TWICE'));
  }
  return days.map(({ weekday, day, around }) => ({
    weekday,
    day: day ?? null,
    around: around ?? [],
  }));
}

/**
 * The weekly auto-plan on /api/v1 (#193b; plan section 6), registered by
 * apiPlugin, each calling what its page twin calls: planWeekFor (the
 * calendar's Plan my week and plan_week), undoWeekPlanFor, and the template's
 * one writer. The token's user's own, like the pages: there is no
 * `?ownerId=`, and another's plan is the 404 of an unknown id.
 */
export const weekPlanApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, config, logger, weather },
  done,
) => {
  app.post(
    '/week-plans',
    {
      schema: {
        operationId: 'planWeek',
        tags: ['week-plan'],
        summary: 'Plan my week',
        description:
          "Fills your week template's empty slots from today to six days on, each dressed for its forecast and occasion, wash limits counted across the week, no outfit twice. Safe to retry: filled slots are left, so a repeat plans nothing (no `weekPlanId`).",
        response: apiResponses({ 200: WeekPlanned }),
      },
    },
    async (request) => {
      const { today, forecast, result } = await planWeekFor(
        { db, logger, weather, timeZone: config.timeZone },
        actorOf(request),
        new Date(),
      );
      return {
        from: today,
        templateSet: result.templateSet,
        ...(result.weekPlanId !== null && { weekPlanId: result.weekPlanId }),
        planned: result.planned.map(toPlannedEntry),
        unfilled: result.unfilled,
        away: result.away,
        weatherDays: forecast.days.size,
      };
    },
  );

  app.delete(
    '/week-plans/:id',
    {
      schema: {
        operationId: 'undoWeekPlan',
        tags: ['week-plan'],
        summary: 'Undoes a Plan my week',
        description:
          "Its entries still the planner's go, with the outfits it made for them that nothing else holds; entries you changed, wore or planned yourself since stay. The plan goes once it has none left: then it is a 404, which a retry may read as done.",
        params: Type.Object({ id: RowId }),
        response: apiResponses({ 200: WeekPlanUndone }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const undone = await undoWeekPlanFor({ db, logger }, actor, id);
      return {
        entriesRemoved: undone.entries,
        outfitsRemoved: undone.outfits,
      };
    },
  );

  app.get(
    '/week-template',
    {
      schema: {
        operationId: 'getWeekTemplate',
        tags: ['week-plan'],
        summary: 'Your week template',
        response: apiResponses({ 200: WeekTemplate }),
      },
    },
    async (request) =>
      toWeekTemplate(await findWeekTemplate(db, actorOf(request).userId)),
  );

  app.put(
    '/week-template',
    {
      schema: {
        operationId: 'saveWeekTemplate',
        tags: ['week-plan'],
        summary: 'Saves your week template, whole',
        description:
          'Every weekday replaced at once: what Plan my week plans from next. Answers the template as saved.',
        body: WeekTemplateInput,
        response: apiResponses({ 200: WeekTemplate }),
      },
    },
    async (request) => {
      const slots = templateSlots(templateDaysOf(request.body.days));
      await saveWeekTemplateFor({ db, logger }, actorOf(request), slots);
      return toWeekTemplate(slots);
    },
  );

  done();
};
