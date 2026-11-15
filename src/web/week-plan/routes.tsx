import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { sessionUserId } from '../auth/require-session';
import type { WebOptions } from '../plugin';
import { renderPage } from '../render';
import { RowId } from '../schemas';
import { actorOf } from '../sharing/access';
import { viewContext } from '../view-context';
import {
  planWeekFor,
  saveWeekTemplateFor,
  undoWeekPlanFor,
} from './plan-actions';
import {
  findWeekTemplate,
  readWeekTemplateForm,
  WeekTemplateBody,
} from './template';
import {
  plannedWeekUrl,
  UNDONE_FLAG,
  WEEK_SAVED_FLAG,
  WEEK_SETTINGS_PATH,
} from './urls';
import { WeekTemplatePage } from './views';

// Navigation state: the saved toast's one-shot flag, shown or not.
const WeekTemplateQuery = Type.Object({
  [WEEK_SAVED_FLAG]: Type.Optional(Type.String()),
});

/**
 * The weekly auto-plan's writes (#16): "Plan my week", its Undo, and the
 * week template, with the template's page (Profile › Your week, #728). The
 * signed-in user's own, like the calendar; shares never reach them. Every
 * write is a native post answered with a 303 (the calendar's banner, the
 * template's page); what the plan shows is read by the calendar's GET.
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

  app.get(
    WEEK_SETTINGS_PATH,
    { schema: { querystring: WeekTemplateQuery } },
    async (request, reply) =>
      renderPage(
        reply,
        <WeekTemplatePage
          ctx={viewContext(reply)}
          slots={await findWeekTemplate(db, sessionUserId(request))}
          saved={request.query[WEEK_SAVED_FLAG] === '1'}
        />,
      ),
  );

  app.post(
    WEEK_SETTINGS_PATH,
    { schema: { body: WeekTemplateBody } },
    async (request, reply) => {
      const slots = readWeekTemplateForm(request.body);
      await saveWeekTemplateFor({ db, logger }, actorOf(request), slots);
      return reply.redirect(`${WEEK_SETTINGS_PATH}?${WEEK_SAVED_FLAG}=1`, 303);
    },
  );

  done();
};
