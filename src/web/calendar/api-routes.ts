import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { addDays, daysBetween, todayIn } from '../../calendar-date';
import { compareOccasions, DEFAULT_OCCASION } from '../../wardrobe/occasions';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { dayAheadRefusal } from '../offline-writes';
import { RowId } from '../schemas';
import { actorOf } from '../sharing/access';
import { markEntryWorn, planOutfit, removeEntry } from './entry-actions';
import {
  CalendarEntryList,
  CalendarEntryQuery,
  CalendarEntryScheduled,
  EntryOutfitChanged,
  EntryOutfitInput,
  EntryWorn,
  entryOutfitChoice,
  EntryWornInput,
  NewCalendarEntry,
  toCalendarEntryResource,
  toEntryOutfitChanged,
} from './entry-resource';
import { findEntries, MAX_CALENDAR_DAYS } from './queries';
import { replaceEntryOutfit } from './replace';
import { BY_PERSON } from '../write-origin';

const EntryParams = Type.Object({ id: RowId });

const ENTRY_PATH = '/calendar-entries/:id';

/**
 * The calendar on /api/v1 (#193b; plan section 6), registered by apiPlugin,
 * each calling what its page twin calls (operations.ts names the twin):
 * entry-actions.ts and replaceEntryOutfit, which take the owner lock
 * themselves and log every write. Entries are private (AGENTS.md): only the token's user's own
 * are reached, there is no `?ownerId=`, and another's entry is the 404 of
 * an unknown id. Days are the household's (GET /me's `today`).
 */
export const calendarApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, config, logger, photos },
  done,
) => {
  const deps = { db, logger };
  app.get(
    '/calendar-entries',
    {
      schema: {
        operationId: 'listCalendarEntries',
        tags: ['calendar'],
        summary: 'Your calendar over a range of days',
        description: `Each entry's outfit with its garments (each piece away marked), whether it was worn, its selfie and who planned it. Seven days unless both ends are sent: from today without dates, from \`from\` with it alone, up to \`to\` with it alone. At most ${MAX_CALENDAR_DAYS} days, else a 400.`,
        querystring: CalendarEntryQuery,
        response: apiResponses({ 200: CalendarEntryList }),
      },
    },
    async (request) => {
      // A week by default: from today, or up to `to` when only it is sent
      // (#570), so `?to=<yesterday>` is the week that ended then.
      const { query } = request;
      const from =
        query.from ??
        (query.to === undefined
          ? todayIn(config.timeZone, new Date())
          : addDays(query.to, -6));
      const to = query.to ?? addDays(from, 6);
      const days = daysBetween(from, to) + 1;
      if (days < 1 || days > MAX_CALENDAR_DAYS) {
        throw new HttpError(
          400,
          t('api.DAY_RANGE', { max: MAX_CALENDAR_DAYS }),
        );
      }
      const entries = await findEntries(db, actorOf(request).userId, from, to);
      return {
        from,
        to,
        // By day (as read), then occasion, as the calendar page stacks them.
        data: entries
          .sort(
            (a, b) =>
              a.day.localeCompare(b.day) ||
              compareOccasions(a.occasion, b.occasion),
          )
          .map(toCalendarEntryResource),
      };
    },
  );

  app.post(
    '/calendar-entries',
    {
      schema: {
        operationId: 'createCalendarEntry',
        tags: ['calendar'],
        summary: 'Plans one of your outfits on a day',
        description:
          'A new entry is 201. The outfit already on that day is that entry, 200 `already-scheduled` with the occasion it kept, so a retry plans nothing twice; planning what Plan my week planned makes it yours (`adopted`). An outfit not yours is a 404.',
        body: NewCalendarEntry,
        response: apiResponses({
          200: CalendarEntryScheduled,
          201: CalendarEntryScheduled,
        }),
      },
    },
    async (request, reply) => {
      const { outfitId, day, clientId } = request.body;
      const occasion = request.body.occasion ?? DEFAULT_OCCASION;
      const scheduled = await planOutfit(
        deps,
        actorOf(request),
        { outfitId, day, occasion },
        BY_PERSON,
        { clientId },
      );
      const adopted =
        scheduled.outcome === 'already-scheduled' && scheduled.adopted;
      const answer = {
        id: scheduled.entryId,
        outcome: scheduled.outcome,
        occasion: scheduled.occasion,
        ...(adopted && { adopted }),
      };
      return reply
        .status(scheduled.outcome === 'scheduled' ? 201 : 200)
        .send(answer);
    },
  );

  app.put(
    `${ENTRY_PATH}/outfit`,
    {
      schema: {
        operationId: 'replaceCalendarEntryOutfit',
        tags: ['calendar'],
        summary: "Changes an entry's outfit, keeping its day and occasion",
        description:
          "Change on the calendar and Today, with a saved outfit (`outfitId`) or an idea's garments (`garmentIds`, from GET /ideas: saved as an outfit, or the outfit they are already). The entry becomes yours (out of the re-plan's reach); an outfit Plan my week made for it goes once nothing holds it; its selfie stays on the day as a look. A worn entry is a 409 (it is the record of that day: plan another outfit instead), and so is an outfit already on the day; nothing is saved then. Set-state: the outfit it holds already is `unchanged`.",
        params: EntryParams,
        body: EntryOutfitInput,
        response: apiResponses({ 200: EntryOutfitChanged }),
      },
    },
    async (request) => {
      const choice = entryOutfitChoice(request.body);
      const replaced = await replaceEntryOutfit(
        deps,
        actorOf(request),
        { entryId: request.params.id },
        choice,
        BY_PERSON,
      );
      return toEntryOutfitChanged(replaced, choice);
    },
  );

  app.put(
    `${ENTRY_PATH}/worn`,
    {
      schema: {
        operationId: 'setCalendarEntryWorn',
        tags: ['calendar'],
        summary: 'Marks an entry worn, or not',
        description:
          "Wore it: each of its outfit's garments worn on the entry's day, the entry yours (out of the re-plan's reach). A day still to come is a 409. Set-state: a repeat is `changed: false`.",
        params: EntryParams,
        body: EntryWornInput,
        response: apiResponses({ 200: EntryWorn }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const { worn } = request.body;
      const now = new Date();
      const outcome = await markEntryWorn(deps, actor, {
        entryId: id,
        worn,
        at: now,
        today: todayIn(config.timeZone, now),
      });
      if (outcome === 'future') {
        throw dayAheadRefusal(
          `Calendar entry ${id} not marked worn for user ${actor.userId}: its day is ahead`,
        );
      }
      return outcome;
    },
  );

  app.delete(
    ENTRY_PATH,
    {
      schema: {
        operationId: 'deleteCalendarEntry',
        tags: ['calendar'],
        summary: 'Takes an entry off the calendar',
        description:
          'Its wears and its selfie go with it (the outfit stays). An entry already gone is a 404, which a retry may read as done.',
        params: EntryParams,
        response: apiResponses({ 204: Type.Null({ description: 'Deleted' }) }),
      },
    },
    async (request, reply) => {
      await removeEntry(
        { ...deps, photos },
        actorOf(request),
        request.params.id,
      );
      return reply.status(204).send(null);
    },
  );

  done();
};
