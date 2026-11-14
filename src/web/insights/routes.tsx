import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import {
  DEFAULT_UNWORN_DAYS,
  isUnwornDays,
  type UnwornDays,
} from '../../wardrobe/insights';
import { sessionUserId } from '../auth/require-session';
import { todayIn } from '../../calendar-date';
import type { WebOptions } from '../plugin';
import { renderPage } from '../render';
import { viewContext } from '../view-context';
import { InsightsPage } from './insights-page';
import { readDefaultRecap, readInsights, readRecap } from './queries';
import { RecapPage } from './recap-page';
import { recapPeriod, recapYear } from './recap-period';
import { INSIGHTS_PATH, RECAP_PATH } from './urls';

// Navigation state (the unworn list's window chips): anything but one of
// the choices falls back to the default, never a 400, so no length limit
// either (one answered a long value 400 before the fallback, #123).
const InsightsQuery = Type.Object({
  unworn: Type.Optional(Type.String()),
});

// `?year=` is navigation state like `?unworn=` (recapYear: anything but a
// four-digit year up to this one is this one). No `?ownerId=`: the schema
// strips it, like every parameter it does not list.
const RecapQuery = Type.Object({
  year: Type.Optional(Type.String()),
});

function unwornDays(value: string | undefined): UnwornDays {
  const days = Number(value);
  return isUnwornDays(days) ? days : DEFAULT_UNWORN_DAYS;
}

/**
 * Insights (#17, plan section 10): how the closet is actually used, from
 * the owner's own wears, so the signed-in user's only, like /laundry:
 * `?ownerId=` is ignored and a share never reaches it. Two statements
 * (src/web/insights/queries.ts), computed on request, nothing stored.
 *
 * The year in review (#26, docs/plans/2026-09-28-yearly-recap.md): the
 * same two statements over a calendar year, and owner-only for the same
 * reason: it is the wear log. `?ownerId=` is ignored; a grantee who passes
 * one sees their own recap.
 */
export const insightsRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger },
  done,
) => {
  app.get(
    INSIGHTS_PATH,
    { schema: { querystring: InsightsQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const today = todayIn(config.timeZone, new Date());
      const days = unwornDays(request.query.unworn);
      const started = performance.now();
      const insights = await readInsights(db, userId, today, days);
      logger.debug(
        `Insights for user ${userId}: ${insights.closet.garments} garment(s), ${insights.pairs.length} pair(s), unworn ${days} days in ${Math.round(performance.now() - started)} ms`,
      );
      return renderPage(
        reply,
        <InsightsPage ctx={viewContext(reply)} model={{ insights, today }} />,
      );
    },
  );

  app.get(
    RECAP_PATH,
    { schema: { querystring: RecapQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const today = todayIn(config.timeZone, new Date());
      const started = performance.now();
      // Without ?year= the page opens on the latest year worth recapping.
      const recap =
        request.query.year === undefined
          ? await readDefaultRecap(db, userId, today)
          : await readRecap(
              db,
              userId,
              recapPeriod(recapYear(request.query.year, today), today),
            );
      logger.debug(
        `Recap ${recap.period.year} for user ${userId}: ${recap.wears} wear(s), ${recap.piecesWorn} piece(s), ${recap.additions.count} added in ${Math.round(performance.now() - started)} ms`,
      );
      return renderPage(
        reply,
        <RecapPage ctx={viewContext(reply)} model={{ recap, today }} />,
      );
    },
  );

  done();
};
