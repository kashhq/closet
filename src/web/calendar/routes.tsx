import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { sessionUserId } from '../auth/require-session';
import { alreadySavedOf } from '../gallery/urls';
import type { WebOptions } from '../plugin';
import {
  answerReplay,
  isReplay,
  replayNote,
  replayRefused,
  requestTap,
} from '../offline-writes';
import { announce, askFirst } from '../announce';
import { t } from '../i18n';
import { navigateTo, renderFragment, renderPage } from '../render';
import { DEFAULT_OCCASION } from '../../wardrobe/occasions';
import {
  type DayDestination,
  DestinationQuery,
  type OutfitDestination,
  parseDestination,
} from '../outfits/destination';
import { OutfitListQuery, parseOutfitList } from '../outfits/outfit-list';
import { OUTFIT_PAGE_SIZE } from '../outfits/page-size';
import { FIRST_OUTFIT_PAGE } from '../outfits/queries';
import { OutfitCursor } from '../outfits/schemas';
import {
  IsoDateSchema,
  OccasionSchema,
  RowId,
  TapInstantSchema,
} from '../schemas';
import { safeReturnTo } from '../security/return-to';
import { actorOf } from '../sharing/access';
import { viewContext } from '../view-context';
import {
  hourIn,
  parseIsoDate,
  parseYearMonth,
  todayIn,
  yearMonthOf,
} from '../../calendar-date';
import { CalendarPage } from './calendar-page';
import {
  buildCalendarView,
  entryView,
  buildMonthView,
  monthRange,
  weekOf,
} from './calendar-view';
import { MonthPage } from './month-page';
import { PlanOutfits, PlanPage } from './plan-page';
import { planContext } from './day-choice';
import { OccasionRow } from './occasion-row';
import {
  markEntryWorn,
  planOutfit,
  calendarEntryNotFound,
  removeEntry,
  requireEntry,
} from './entry-actions';
import { findEntries, type Scheduled } from './queries';
import { replaceEntryOutfit, replaceMessage } from './replace';
import {
  CALENDAR_MONTH_PATH,
  CALENDAR_PATH,
  CALENDAR_PLAN_MORE_PATH,
  CALENDAR_PLAN_PATH,
  CALENDAR_RESTORE_PATH,
  weekUrl,
} from './urls';
import { weekContext } from './week-context';
import { createUndoStore, restorable } from './restore';
import { BY_PERSON } from '../write-origin';

/**
 * Validation, decided per route:
 * - GET /calendar reads ?week= and GET /calendar/month ?month= leniently: a
 *   missing or malformed value falls back (the current week, this month),
 *   since they are navigation state in a shareable URL and a stale or
 *   mangled link should still open the calendar. parseIsoDate/parseYearMonth
 *   decide. The mini month's ?calMonth= (before R6) is ignored.
 * - GET /calendar/plan reads ?for=, ?occasion= and ?replace= the same way
 *   (parseDestination): no day is today, an unknown occasion all day, and
 *   a `replace` that is not the user's entry there plans one more outfit.
 * - POST /calendar's `replace` is data (RowId, else a 400); the entry must
 *   be the user's on `date` for `occasion` (else a 404, replaceEntryOutfit's).
 * - The writes validate their bodies strictly through the route schema: a
 *   malformed date, outfit id, occasion or week is a 400 error page and
 *   writes nothing (IsoDateSchema: the rule parseIsoDate also applies). A
 *   post without an occasion (the pages cached before #13) is all day.
 * - POST /calendar/:id/delete and /worn take their body as optional: the
 *   posted week only picks the redirect target, and /worn's `worn` the
 *   state to set (absent: a toggle, as pills cached before it posted).
 */
const EntryParams = Type.Object({ id: RowId });

// null: a post without a body (Fastify validates a missing body as null).
// Remove's body: `confirmed` is posted by the confirm sheet's yes (#686).
const DeleteBody = Type.Union([
  Type.Object({
    week: Type.Optional(IsoDateSchema),
    confirmed: Type.Optional(Type.Literal('1')),
  }),
  Type.Null(),
]);

const WornBody = Type.Union([
  Type.Object({
    week: Type.Optional(IsoDateSchema),
    worn: Type.Optional(Type.Union([Type.Literal('1'), Type.Literal('0')])),
    // Where a plain post goes back to (WornControl's page), through
    // safeReturnTo; else the posted week (pills cached before #359).
    returnTo: Type.Optional(Type.String({ maxLength: 2048 })),
    // The tap's instant (#676), posted by the outbox's replay: the wears'
    // worn_at, for a same-day wash's order (requestTap).
    at: Type.Optional(TapInstantSchema),
  }),
  Type.Null(),
]);

/** The log line for what POST /calendar/:id/worn did. */
function wornMessage(
  id: number,
  ownerId: number,
  outcome: { worn: boolean; changed: boolean; wears: number },
): string {
  const state = outcome.worn ? 'worn' : 'not worn';
  if (!outcome.changed) {
    return `Calendar entry ${id} already ${state} for user ${ownerId}`;
  }
  const wears = `${outcome.wears} wears ${outcome.worn ? 'logged' : 'removed'}`;
  return `Calendar entry ${id} marked ${state} by user ${ownerId} (${wears})`;
}

function scheduleMessage(
  ownerId: number,
  entry: { outfitId: number; day: string; occasion: string },
  scheduled: Scheduled,
): string {
  const { outfitId, day, occasion } = entry;
  if (scheduled.outcome === 'scheduled') {
    return `Outfit ${outfitId} scheduled on ${day} (${occasion}) by user ${ownerId}`;
  }
  const adopted = scheduled.adopted
    ? "; the week planner's entry is the user's now"
    : '';
  return `Outfit ${outfitId} already scheduled on ${day} for user ${ownerId}; ${occasion} not added${adopted}`;
}

/** `?planned=`: a batch id or 'none'; anything else is no banner. */
function parsePlanned(value: string | undefined): number | 'none' | undefined {
  if (value === 'none') return 'none';
  return value !== undefined && /^[1-9]\d{0,9}$/.test(value)
    ? Number(value)
    : undefined;
}

/**
 * The outfit calendar: the week page and its writes. Outfits and entries are
 * the signed-in user's own; wardrobe shares never reach them, and
 * `?ownerId=` is ignored.
 */
export const calendarRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger, photos },
  done,
) => {
  // The plan page's day (and its sentinel's): navigation state, so none
  // (missing or malformed) is today, all day.
  const planDestination = (parsed: OutfitDestination): DayDestination =>
    parsed.kind === 'day'
      ? parsed
      : {
          kind: 'day',
          day: todayIn(config.timeZone, new Date()),
          occasion: DEFAULT_OCCASION,
        };

  app.get(
    CALENDAR_PATH,
    {
      schema: {
        querystring: Type.Object({
          week: Type.Optional(Type.String()),
          // The gallery's pick of an outfit already saved (a one-shot flag).
          alreadySaved: Type.Optional(Type.String()),
          // After "Plan my week" (#16): its batch id, or 'none'; and after
          // its Undo, how many entries went. Navigation state: anything
          // malformed, or another's batch, shows nothing.
          planned: Type.Optional(Type.String({ maxLength: 12 })),
          undone: Type.Optional(Type.String({ maxLength: 6 })),
        }),
      },
    },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { week } = request.query;
      const today = todayIn(config.timeZone, new Date());
      const anchor = parseIsoDate(week);
      if (week && !anchor) {
        logger.debug(
          `GET /calendar: malformed week ${JSON.stringify(week)}, showing the current week`,
        );
      }
      const shown = weekOf(anchor ?? today);
      const planned = parsePlanned(request.query.planned);
      const { entries, looks, template, banner, canDress, trips } =
        await weekContext(
          db,
          ownerId,
          { ...shown, today },
          planned === undefined
            ? undefined
            : { planned, today, hour: hourIn(config.timeZone, new Date()) },
        );
      const undone = request.query.undone;
      const view = buildCalendarView({
        weekStart: shown.start,
        today,
        entries,
        looks,
        template,
        trips,
      });
      return renderPage(
        reply,
        <CalendarPage
          ctx={viewContext(reply)}
          view={view}
          alreadySaved={alreadySavedOf(request.query.alreadySaved)}
          banner={banner}
          canDress={canDress}
          undone={
            undone !== undefined && /^\d+$/.test(undone)
              ? Number(undone)
              : undefined
          }
        />,
      );
    },
  );

  // The month of collages (R6): the history, each day linking to its week.
  app.get(
    CALENDAR_MONTH_PATH,
    {
      schema: {
        querystring: Type.Object({ month: Type.Optional(Type.String()) }),
      },
    },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const today = todayIn(config.timeZone, new Date());
      const asked = parseYearMonth(request.query.month);
      if (request.query.month !== undefined && !asked) {
        logger.debug(
          `GET ${CALENDAR_MONTH_PATH}: malformed month ${JSON.stringify(request.query.month)}, showing this month`,
        );
      }
      const month = asked ?? yearMonthOf(today);
      const { first, last } = monthRange(month);
      const entries = await findEntries(db, ownerId, first, last);
      return renderPage(
        reply,
        <MonthPage
          ctx={viewContext(reply)}
          view={buildMonthView({ month, today, entries })}
        />,
      );
    },
  );

  // Plan one more outfit on a day: the occasion, then build one or pick a
  // saved one (Change, #69; the "+ Plan" sheet picks saved ones on /outfits).
  app.get(
    CALENDAR_PLAN_PATH,
    {
      schema: {
        querystring: Type.Object({ ...DestinationQuery, ...OutfitListQuery }),
      },
    },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const parsed = parseDestination(request.query);
      const list = parseOutfitList(request.query.show);
      const destination = planDestination(parsed);
      if (parsed.kind === 'none' && request.query.for !== undefined) {
        logger.debug(
          `GET /calendar/plan: no day in ${JSON.stringify(request.query.for)}, planning today`,
        );
      }
      const { page, choice } = await planContext(
        db,
        ownerId,
        destination,
        list,
        FIRST_OUTFIT_PAGE,
      );
      if (destination.replace !== undefined && !choice.replacing) {
        logger.debug(
          `GET /calendar/plan: entry ${destination.replace} is not user ${ownerId}'s on ${destination.day} (${destination.occasion}), planning another`,
        );
      }
      return renderPage(
        reply,
        <PlanPage
          ctx={viewContext(reply)}
          model={{
            day: destination.day,
            occasion: destination.occasion,
            ...page,
            list,
            ...choice,
          }}
        />,
      );
    },
  );

  // The plan page's sentinel (hx-trigger="revealed", #660): its saved
  // outfits below `before`, judged for the same day (and entry), and the
  // next sentinel. Always a fragment.
  app.get(
    CALENDAR_PLAN_MORE_PATH,
    {
      schema: {
        querystring: Type.Object({
          ...DestinationQuery,
          ...OutfitListQuery,
          before: OutfitCursor,
        }),
      },
    },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const parsed = parseDestination(request.query);
      const list = parseOutfitList(request.query.show);
      const destination = planDestination(parsed);
      const { before } = request.query;
      const { page, choice } = await planContext(
        db,
        ownerId,
        destination,
        list,
        { before, limit: OUTFIT_PAGE_SIZE },
      );
      logger.debug(
        `GET ${CALENDAR_PLAN_MORE_PATH}: ${page.outfits.length} ${list} outfits of user ${ownerId} below ${before} for ${destination.day}${page.next === null ? ', the last page' : ''}`,
      );
      return renderFragment(
        reply,
        <PlanOutfits
          destination={destination}
          list={list}
          outfits={page.outfits}
          next={page.next}
          choice={choice}
        />,
      );
    },
  );

  // A native post, 302 to the day's week: the plan page's and the Saved
  // tab's pick (?for=day:), and the outfit page's Plan sheet. With `replace`
  // (changing an entry, #69) the outfit takes that entry's place instead of
  // joining the day: replaceEntryOutfit. The outfit list's htmx dropdown
  // (answered 204) went with R5; a page cached before it still posts here
  // and its request follows the redirect, which it does not swap.
  app.post(
    CALENDAR_PATH,
    {
      schema: {
        body: Type.Object({
          date: IsoDateSchema,
          outfitId: RowId,
          occasion: Type.Optional(OccasionSchema),
          week: Type.Optional(IsoDateSchema),
          replace: Type.Optional(RowId),
        }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { date, outfitId, week, replace } = request.body;
      const occasion = request.body.occasion ?? DEFAULT_OCCASION;
      if (replace !== undefined) {
        const target = { entryId: replace, day: date, occasion };
        const replaced = await replaceEntryOutfit(
          db,
          actor,
          target,
          { outfitId },
          BY_PERSON,
        );
        logger.info(replaceMessage(actor.userId, target, replaced));
        return reply.redirect(weekUrl(week ?? date), 302);
      }
      const entry = { outfitId, day: date, occasion };
      const scheduled = await planOutfit(db, actor, entry, BY_PERSON);
      logger.info(scheduleMessage(actor.userId, entry, scheduled));
      return reply.redirect(weekUrl(week ?? date), 302);
    },
  );

  // The row's Remove (#686). The server decides whether it may go unasked
  // (removeEntry's `asksFirst`, from the current row, never the page's): an
  // unworn entry Undo can restore goes at once and the toast offers Undo
  // (POST /calendar/restore, a token for the snapshot held here); a worn
  // entry, an agent's or one that takes a one-off outfit with it is refused
  // 409 with nothing deleted, and the answer opens the confirm sheet, whose
  // yes posts again with `confirmed`. A native post (no htmx) never asks.
  // htmx swaps the page to the week the chip was on; a native post gets the
  // 303 there.
  const undo = createUndoStore();
  app.post(
    '/calendar/:id/delete',
    { schema: { params: EntryParams, body: DeleteBody } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const week = request.body?.week;
      const htmx = Boolean(request.headers['hx-request']);
      const removed = await removeEntry({ db, photos, logger }, actor, id, {
        asksFirst: htmx && request.body?.confirmed !== '1',
      });
      const target = weekUrl(week);
      if (removed === 'needs-confirmation') {
        return askFirst(reply, {
          question: t('CALENDAR_DELETE_CONFIRM'),
          label: t('CALENDAR_REMOVE'),
          action: `/calendar/${id}/delete`,
          fields: { ...(week && { week }), confirmed: '1' },
        });
      }
      if (htmx) {
        const snapshot = restorable(removed);
        announce(
          reply,
          t('CALENDAR_REMOVED'),
          snapshot && {
            label: t('UNDO'),
            action: CALENDAR_RESTORE_PATH,
            fields: { token: undo.put(actor.userId, snapshot) },
          },
        );
        return navigateTo(reply, target);
      }
      return reply.redirect(target, 303);
    },
  );

  // Undo of the delete above: only the token the delete's toast carried.
  // The server re-plans the entry it held, as it was (the planner's `auto`
  // or the person's `user`); nothing about it comes from the client. The
  // token is the owner's, works once and expires; the outfit it held was
  // kept, so it is still there unless deleted since: 404.
  app.post(
    CALENDAR_RESTORE_PATH,
    {
      schema: { body: Type.Object({ token: Type.String({ maxLength: 64 }) }) },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const removed = undo.take(actor.userId, request.body.token);
      if (!removed) throw calendarEntryNotFound();
      const scheduled = await planOutfit(
        db,
        actor,
        {
          outfitId: removed.outfitId,
          day: removed.day,
          occasion: removed.occasion,
        },
        removed.plannedBy === 'auto' ? 'planner' : BY_PERSON,
      );
      logger.info(
        `Calendar entry ${scheduled.entryId} restored (${removed.plannedBy}) by user ${actor.userId} (Undo)`,
      );
      const target = weekUrl(removed.day);
      if (request.headers['hx-request']) {
        announce(reply, t('CALENDAR_RESTORED'));
        return navigateTo(reply, target);
      }
      return reply.redirect(target, 303);
    },
  );

  // Every WornControl on an entry: the calendar's pill (htmx, answered with
  // the entry's whole row), Today's and a trip's (plain posts back through `returnTo`).
  // The entry and its wears change
  // together (setEntryWorn). A day after today is refused (409): its chip
  // has no pill, so only a page the installed app cached before that rule
  // posts it.
  // Queueable (#178): a replay is answered 204 (src/web/offline-writes.ts),
  // last write wins between Wore it and Undo.
  app.post(
    '/calendar/:id/worn',
    {
      config: { queueable: 'entry' },
      schema: { params: EntryParams, body: WornBody },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const posted = request.body?.worn;
      const now = new Date();
      const today = todayIn(config.timeZone, now);
      const outcome = await markEntryWorn(db, actor, {
        entryId: id,
        worn: posted === undefined ? undefined : posted === '1',
        at: now,
        today,
        tap: requestTap(request, request.body?.at, config.timeZone),
      });
      if (outcome === 'future') {
        logger.info(`Calendar entry ${id}: not marked worn, its day is ahead`);
        throw replayRefused(reply, 'future', {
          message: 'A planned day cannot be marked worn yet',
        });
      }
      logger.info(
        `${wornMessage(id, actor.userId, outcome)}${replayNote(request)}`,
      );
      if (isReplay(request)) return answerReplay(reply, outcome.changed);
      const back = safeReturnTo(
        request.body?.returnTo,
        weekUrl(request.body?.week),
      );
      if (request.headers['hx-request']) {
        // The whole row replaces the posted one: its marks, label and
        // Change depend on the worn state too. Read as the week reads it.
        const entry = await requireEntry(
          db,
          actor,
          { id, day: outcome.day },
          today,
        );
        // The headers, not the posted markup, decide where it lands: a
        // cached pre-#369 page has a pill targeting itself, which would
        // nest the row inside the row. Every generation of the row carries
        // `data-occasion`, and the control sits inside it.
        reply.header('HX-Retarget', 'closest [data-occasion]');
        reply.header('HX-Reswap', 'outerHTML');
        // The row's button keeps its id, so htmx refocuses it (#679).
        announce(
          reply,
          outcome.worn ? t('wear.status.WORN') : t('wear.status.UNDO_WORN'),
        );
        return renderFragment(
          reply,
          <OccasionRow
            entry={entryView(entry, today)}
            future={outcome.day > today}
            past={outcome.day < today}
          />,
        );
      }
      return reply.redirect(back, 303);
    },
  );

  done();
};
