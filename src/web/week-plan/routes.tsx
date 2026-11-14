import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { WebOptions } from '../plugin';
import { RowId } from '../schemas';
import { actorOf } from '../sharing/access';
import {
  planWeekFor,
  saveWeekTemplateFor,
  undoWeekPlanFor,
} from './plan-actions';
import { readWeekTemplateForm, WeekTemplateBody } from './template';
import {
  plannedWeekUrl,
  UNDONE_FLAG,
  WEEK_SAVED_FLAG,
  WEEK_SETTINGS_ID,
  WEEK_SETTINGS_PATH,
} from './urls';

/**
 * The weekly auto-plan's writes (#16): "Plan my week", its Undo, and the
 * Profile's week template. The signed-in user's own, like the calendar;
 * shares never reach them. Every one is a native post answered with a 303
 * (the calendar's banner, the profile's section); what they show is read
 * by the calendar's and the profile's GET routes.
 *
 * Validation: "Plan my week" takes no input (an empty body is null); the
 * undo's id is data (not an id: 400; not the owner's batch: 404); the
 * template is WeekTemplateBody (an occasion outside its field's set: 400).
 */
export const weekPlanRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger, weather },
  done,
) => {
  app.post('/calendar/plan-week', async (request, reply) => {
    const { result } = await planWeekFor(
      { db, logger, weather, timeZone: config.timeZone },
      actorOf(request),
      new Date(),
    );
    if (!result.templateSet) return reply.redirect(WEEK_SETTINGS_PATH, 303);
    if (result.weekPlanId === null) {
      return reply.redirect(plannedWeekUrl('none'), 303);
    }
    // The calendar shows Sunday to Saturday, not "today and six": land on
    // the week and the day the plan starts (#683). ISO dates sort as text.
    const firstDay = result.planned.map((p) => p.day).sort()[0];
    return reply.redirect(plannedWeekUrl(result.weekPlanId, firstDay), 303);
  });

  app.post(
    '/calendar/plan-week/:id/undo',
    { schema: { params: Type.Object({ id: RowId }) } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const undone = await undoWeekPlanFor({ db, logger }, actor, id);
      return reply.redirect(`/calendar?${UNDONE_FLAG}=${undone.entries}`, 303);
    },
  );

  app.post(
    '/auth/profile/week',
    { schema: { body: WeekTemplateBody } },
    async (request, reply) => {
      const slots = readWeekTemplateForm(request.body);
      await saveWeekTemplateFor({ db, logger }, actorOf(request), slots);
      return reply.redirect(
        `/auth/profile?${WEEK_SAVED_FLAG}=1#${WEEK_SETTINGS_ID}`,
        303,
      );
    },
  );

  done();
};
