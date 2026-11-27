import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import {
  DEFAULT_OCCASION,
  isOccasion,
  type Occasion,
} from '../../wardrobe/occasions';
import { sessionUserId } from '../auth/require-session';
import { todayIn } from '../../calendar-date';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import { OccasionSchema, RowId } from '../schemas';
import { viewContext } from '../view-context';
import { actorOf } from '../sharing/access';
import { MAX_WORN_GARMENTS } from './queries';
import { wearIdeaOn } from './today-actions';
import { MAX_TODAY_PAGE, todayFor, todayIdeas } from './today';
import { IdeasRowView, TodayPage } from './today-page';
import {
  TODAY_IDEAS_PATH,
  TODAY_PATH,
  todayAfterWear,
  WEAR_THIS_PATH,
} from './urls';

/**
 * Today (#15): the home screen and its writes. The signed-in user's own
 * day, like the calendar; `?ownerId=` is not read.
 *
 * Validation, decided per parameter:
 * - Refresh's `?occasion=` and `?page=` are navigation state the page
 *   built: anything malformed is all day, page 1.
 * - "Wear this" posts data it stores (garments, the occasion): malformed is
 *   a 400, garments not the user's closet's a 404 with nothing written.
 * - "Wore it" and its undo are the calendar's worn route
 *   (POST /calendar/:id/worn with `returnTo=/`): one write for an entry's
 *   worn state, wherever it is tapped.
 */

const IdeasQuery = Type.Object({
  occasion: Type.Optional(Type.String()),
  page: Type.Optional(Type.String()),
});

// URL state, so lenient: a malformed or repeated `wore` (`?wore=1&wore=2`
// arrives as an array) is no flag or the first valid one, never a 400.
const TodayQuery = Type.Object({
  wore: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
});

function parseEntryId(
  value: string | string[] | undefined,
): number | undefined {
  const id = [value ?? []]
    .flat()
    .find((candidate) => /^\d{1,9}$/.test(candidate));
  return id === undefined ? undefined : Number(id);
}

const WearBody = Type.Object({
  garmentId: Type.Array(RowId, { minItems: 1, maxItems: MAX_WORN_GARMENTS }),
  occasion: OccasionSchema,
});

function parseOccasion(value: string | undefined): Occasion {
  return value !== undefined && isOccasion(value) ? value : DEFAULT_OCCASION;
}

function parsePage(value: string | undefined): number {
  const page =
    value !== undefined && /^\d{1,3}$/.test(value) ? Number(value) : 1;
  return page >= 1 && page <= MAX_TODAY_PAGE ? page : 1;
}

export const todayRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger, weather },
  done,
) => {
  const deps = { db, weather, timeZone: config.timeZone };

  // Signed out, the session gate sends it to the login page like any page.
  app.get(
    TODAY_PATH,
    { schema: { querystring: TodayQuery } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const started = performance.now();
      const now = new Date();
      const model = await todayFor(deps, ownerId, now, {
        needs: true,
        firstRun: true,
      });
      logger.debug(
        `Today for user ${ownerId} (${model.today}): ${model.rows.map((row) => `${row.occasion} ${row.kind === 'planned' ? `planned ${row.entries.length}` : `${row.ideas.length} ideas`}`).join(', ')}${model.needs ? `, ${model.needs.count} agent needs waiting` : ''}${model.firstRun ? `, first run (${model.firstRun})` : ''} in ${Math.round(performance.now() - started)} ms`,
      );
      return renderPage(
        reply,
        <TodayPage
          ctx={viewContext(reply)}
          model={model}
          timeZone={config.timeZone}
          now={now}
          wore={parseEntryId(request.query.wore)}
        />,
      );
    },
  );

  // Refresh: the row's next page of ideas, in place (always a fragment).
  app.get(
    TODAY_IDEAS_PATH,
    { schema: { querystring: IdeasQuery } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const now = new Date();
      const row = await todayIdeas(
        deps,
        ownerId,
        now,
        parseOccasion(request.query.occasion),
        parsePage(request.query.page),
      );
      return renderFragment(
        reply,
        <IdeasRowView row={row} today={todayIn(config.timeZone, now)} />,
      );
    },
  );

  // "Wear this" (a native post): the idea becomes an outfit planned today
  // and worn, in one transaction; a double tap lands on the same outfit and
  // entry (wearIdea). Back to Today, which then shows it planned and worn,
  // focus on its Undo and the result said (WORE_FLAG, #679).
  app.post(
    WEAR_THIS_PATH,
    { schema: { body: WearBody } },
    async (request, reply) => {
      const now = new Date();
      const { garmentId, occasion } = request.body;
      const today = todayIn(config.timeZone, now);
      const { entryId } = await wearIdeaOn({ db, logger }, actorOf(request), {
        garmentIds: garmentId,
        occasion,
        day: today,
        today,
        at: now,
      });
      return reply.redirect(todayAfterWear(entryId), 303);
    },
  );

  done();
};
