import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Static } from '@sinclair/typebox';
import { isOccasion, type Occasion } from '../../wardrobe/occasions';
import { sessionUserId } from '../auth/require-session';
import { AutosaveSaved } from '../autosave';
import { addDays, parseIsoDate, todayIn } from '../../calendar-date';
import { unchecked } from '../checklist';
import type { WebOptions } from '../plugin';
import { answerReplay, isReplay, replayNote } from '../offline-writes';
import { navigateTo, renderFragment, renderPage } from '../render';
import {
  enforceLimit,
  WEATHER_SEARCH_LIMIT,
  type WeatherLimits,
} from '../security/rate-limit';
import { type Actor, actorOf } from '../sharing/access';
import { viewContext } from '../view-context';
import {
  PLACE_QUERY_MAX,
  PLACE_QUERY_MIN,
  PlaceBody,
  PlaceQuery,
  type PickedPlace,
  pickedPlace,
  placeAnswer,
} from '../weather/place-picker';
import { AddOutfitButtons, AddOutfitPage } from './add-page';
import { tripForecast } from './forecast';
import {
  DestinationPicker,
  NEW_TRIP_DESTINATION_PATH,
  NEW_TRIP_PLACE_PATH,
  NEW_TRIP_PLACES_PATH,
  NewTripPlaceResults,
  TripFormPage,
  type TripFormModel,
} from './form-page';
import { TripsPage } from './list-page';
import { tripModel } from './model';
import type { PackedChange } from './packed';
import { createTripAt, listTrips, outfitsOnDay, tripDays } from './queries';
import {
  addTripItem,
  type ChecklistTicks,
  copyTripExtras,
  editTrip,
  locateTrip,
  packTrip,
  packTripItems,
  planTripOutfit,
  removeTrip,
  removeTripExtra,
  requireAddOutfitPage,
  requireTrip,
  requireTripPage,
  takeOffTrip,
  wearTripOutfit,
} from './trip-actions';
import { parseOutfitList } from '../outfits/outfit-list';
import { OUTFIT_PAGE_SIZE } from '../outfits/page-size';
import { FIRST_OUTFIT_PAGE, type OutfitPageAsk } from '../outfits/queries';
import { ItemsSummary, PackedSummary, TripPage } from './trip-page';
import { dayAnchor, TRIPS_PATH, tripUrl } from './urls';
import {
  AddOutfitBody,
  AddOutfitMoreQuery,
  AddOutfitQuery,
  ChecklistBody,
  CopyItemsBody,
  formPlace,
  ItemBody,
  NewTripBody,
  NewTripDestinationQuery,
  NewTripPlacesQuery,
  readTripForm,
  type TripBody,
  TripBody as TripBodySchema,
  type TripForm,
  TripItemParams,
  TripOutfitParams,
  TripPageQuery,
  TripParams,
} from './validation';
import { TripPlaceResults, TripWeather } from './weather';
import { BY_PERSON } from '../write-origin';

/**
 * Trips (#10; plan section 4): the Calendar's Trips tab and every trip
 * write. The owner's own, like outfits: `?ownerId=` is not read, another
 * user's trip, trip outfit or extra is a 404 like an unknown id, and shares
 * never reach them (trip-actions.ts refuses; matrix rows in
 * test/integration/authorization-trips.spec.ts). Handlers parse, call and
 * render.
 *
 * Validation, decided per parameter:
 * - The trip form's fields are data it stores: past their caps a 400 page,
 *   a blank name or a bad date range the form again with messages (400,
 *   a native post).
 * - The add page's `?day=` and `?occasion=` are navigation state: anything
 *   that is not one of the trip's days, or an occasion, is none.
 * - Every other write posts ids and values the pages built: malformed is a
 *   400, a day outside the trip a 400 too (planTripOutfit's refusal),
 *   anything not the owner's a 404 with nothing written.
 * - The weather routes (the forecast fragment, the place search, setting
 *   the located destination, the new-trip form's picker) exist only with
 *   WEATHER_ENABLED, like
 *   /weather/*; the search is rate limited and its query never logged.
 */
export const tripRoutes: FastifyPluginCallbackTypebox<
  WebOptions & WeatherLimits
> = (app, { db, config, logger, weather, weatherLimits }, done) => {
  const today = () => todayIn(config.timeZone, new Date());

  function renderForm(
    reply: FastifyReply,
    model: TripFormModel,
    status = 200,
  ): Promise<FastifyReply> {
    return renderPage(
      reply,
      <TripFormPage ctx={viewContext(reply)} model={model} />,
      { status },
    );
  }

  /** A new trip's destination picker: only with WEATHER_ENABLED, whose search it asks. */
  const picker = (place: PickedPlace | null) =>
    weather ? { place } : undefined;

  function refuseForm(
    reply: FastifyReply,
    refused: TripForm & { ok: false },
    form: Pick<TripFormModel, 'tripId' | 'picker'>,
  ): Promise<FastifyReply> {
    logger.warn(
      `Trip form refused (${form.tripId === undefined ? 'new' : `trip ${form.tripId}`}): ${Object.keys(refused.errors).join(', ')}`,
    );
    return renderForm(
      reply,
      { ...form, values: formValues(refused.values), errors: refused.errors },
      400,
    );
  }

  /** Back to the trip's page (a section of it) after a plain post. */
  function backToTrip(reply: FastifyReply, tripId: number, anchor?: string) {
    return reply.redirect(
      `${tripUrl(tripId)}${anchor ? `#${anchor}` : ''}`,
      303,
    );
  }

  app.get(TRIPS_PATH, async (request, reply) => {
    const ownerId = sessionUserId(request);
    const day = today();
    const trips = await listTrips(db, ownerId, day);
    return renderPage(
      reply,
      <TripsPage ctx={viewContext(reply)} trips={trips} today={day} />,
    );
  });

  app.get(`${TRIPS_PATH}/new`, async (_request, reply) => {
    // A week from tomorrow, a common first guess the date inputs then move.
    const starts = addDays(today(), 1);
    return renderForm(reply, {
      picker: picker(null),
      values: {
        name: '',
        destination: '',
        startsOn: starts,
        endsOn: addDays(starts, 2),
        notes: '',
      },
    });
  });

  app.post(
    TRIPS_PATH,
    { schema: { body: NewTripBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const place = formPlace(request.body);
      const form = readTripForm(request.body);
      if (!form.ok) return refuseForm(reply, form, { picker: picker(place) });
      // A located trip costs what a set destination does (its forecast's fetch and cached row).
      if (place) {
        await enforceLimit(weatherLimits.destination, request, {
          logger,
          who: `user ${ownerId}`,
        });
      }
      const { id, away } = await createTripAt(
        db,
        ownerId,
        form.fields,
        place,
        today(),
      );
      // Whether it was located, never the place: where someone travels is theirs.
      logger.info(
        `Trip ${id} created by user ${ownerId}: ${form.fields.startsOn} to ${form.fields.endsOn}${place ? ', destination located' : ''}${away > 0 ? `, ${away} planned entr(ies) removed from its days` : ''}`,
      );
      return reply.redirect(tripUrl(id, '?created=1'), 303);
    },
  );

  app.get(
    `${TRIPS_PATH}/:id`,
    { schema: { params: TripParams, querystring: TripPageQuery } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const started = performance.now();
      const model = await requireTripPage(db, actor, id, today());
      logger.debug(
        `Trip ${id} for user ${actor.userId}: ${model.days.length} day(s), ${model.packing.garments} garment(s) to pack (${model.packing.packed} packed, ${model.packing.warned} warned), ${model.items.length} extra(s) in ${Math.round(performance.now() - started)} ms`,
      );
      return renderPage(
        reply,
        <TripPage
          ctx={viewContext(reply)}
          model={{
            ...model,
            created: request.query.created === '1',
            picked: request.query.picked === '1',
            copied: request.query.copied,
          }}
        />,
      );
    },
  );

  app.get(
    `${TRIPS_PATH}/:id/edit`,
    { schema: { params: TripParams } },
    async (request, reply) => {
      const { id } = request.params;
      const trip = await requireTrip(db, actorOf(request), id);
      return renderForm(reply, {
        tripId: id,
        values: {
          name: trip.name,
          destination: trip.destination ?? '',
          startsOn: trip.startsOn,
          endsOn: trip.endsOn,
          notes: trip.notes ?? '',
        },
      });
    },
  );

  app.post(
    `${TRIPS_PATH}/:id`,
    { schema: { params: TripParams, body: TripBodySchema } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const form = readTripForm(request.body);
      if (!form.ok) {
        // The form again only for the owner's trip; anyone else's is a 404
        // whatever was posted. A valid post asks editTrip instead.
        await requireTrip(db, actor, id);
        return refuseForm(reply, form, { tripId: id });
      }
      const saved = await editTrip(db, actor, id, form.fields, today());
      logger.info(
        `Trip ${id} updated by user ${actor.userId}: ${form.fields.startsOn} to ${form.fields.endsOn}${saved.undated > 0 ? `, ${saved.undated} outfit(s) moved to any day` : ''}${saved.locationCleared ? ', destination location cleared' : ''}${saved.away > 0 ? `, ${saved.away} planned entr(ies) removed from its days` : ''}`,
      );
      return backToTrip(reply, id);
    },
  );

  // htmx (hx-delete, hx-confirm): the outfits stay.
  app.delete(
    `${TRIPS_PATH}/:id`,
    { schema: { params: TripParams } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      await removeTrip(db, actor, id);
      logger.info(`Trip ${id} deleted by user ${actor.userId}`);
      return navigateTo(reply, TRIPS_PATH);
    },
  );

  // ---- Outfits ----------------------------------------------------------------

  /**
   * The add page's model for a page of its saved outfits: the trip's, the
   * day and occasion asked (navigation state: one not the trip's, or not
   * an occasion, is none) and what is on the trip that day. The page's and
   * its sentinel's, so both judge alike.
   */
  async function addOutfitModel(
    actor: Actor,
    tripId: number,
    query: Static<typeof AddOutfitQuery>,
    page: OutfitPageAsk,
  ) {
    const list = parseOutfitList(query.show);
    const found = await requireAddOutfitPage(db, actor, tripId, list, page);
    const { trip } = found;
    const days = tripDays(trip);
    const asked = parseIsoDate(query.day);
    const day = asked && days.includes(asked) ? asked : undefined;
    const occasion =
      query.occasion !== undefined && isOccasion(query.occasion)
        ? query.occasion
        : undefined;
    return {
      trip,
      days,
      day,
      occasion,
      list,
      ...found.outfits,
      onTrip: outfitsOnDay(found.onTrip, day ?? null),
    };
  }

  app.get(
    `${TRIPS_PATH}/:id/outfits/new`,
    { schema: { params: TripParams, querystring: AddOutfitQuery } },
    async (request, reply) =>
      renderPage(
        reply,
        <AddOutfitPage
          ctx={viewContext(reply)}
          model={await addOutfitModel(
            actorOf(request),
            request.params.id,
            request.query,
            FIRST_OUTFIT_PAGE,
          )}
        />,
      ),
  );

  // The add page's sentinel (hx-trigger="revealed", #660): its saved
  // outfits below `before`, judged for the same day, and the next
  // sentinel. Always a fragment; one statement after the session, as the page.
  app.get(
    `${TRIPS_PATH}/:id/outfits/new/more`,
    { schema: { params: TripParams, querystring: AddOutfitMoreQuery } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { before } = request.query;
      const model = await addOutfitModel(
        actor,
        request.params.id,
        request.query,
        { before, limit: OUTFIT_PAGE_SIZE },
      );
      logger.debug(
        `GET /trips/${model.trip.id}/outfits/new/more: ${model.outfits.length} ${model.list} outfits of user ${actor.userId} below ${before}${model.next === null ? ', the last page' : ''}`,
      );
      return renderFragment(reply, <AddOutfitButtons model={model} />);
    },
  );

  app.post(
    `${TRIPS_PATH}/:id/outfits`,
    { schema: { params: TripParams, body: AddOutfitBody } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const { outfitId } = request.body;
      const day = request.body.day || undefined;
      const occasion: Occasion | undefined = request.body.occasion || undefined;
      const outcome = await planTripOutfit(
        db,
        actor,
        { tripId: id, outfitId, day, occasion },
        BY_PERSON,
      );
      logger.info(
        `Outfit ${outfitId} ${outcome === 'added' ? 'added to' : 'already on'} trip ${id} by user ${actor.userId} (${day ?? 'any day'}${occasion ? `, ${occasion}` : ''})`,
      );
      return backToTrip(reply, id, dayAnchor(day ?? null));
    },
  );

  app.post(
    `${TRIPS_PATH}/:id/outfits/:tripOutfitId/delete`,
    { schema: { params: TripOutfitParams } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id, tripOutfitId } = request.params;
      const outcome = await takeOffTrip(db, actor, {
        tripId: id,
        tripOutfitId,
      });
      logger.info(
        `Outfit ${outcome.outfitId} taken off trip ${id} by user ${actor.userId} (trip outfit ${tripOutfitId}; ${outcome.unpacked} packed mark(s) removed with its garments)`,
      );
      return backToTrip(reply, id);
    },
  );

  // A trip's "Wore it" (WornControl's createUrl): wearTripOutfit, through
  // the calendar's writers; a 409 unless the outfit is wearable today.
  app.post(
    `${TRIPS_PATH}/:id/outfits/:tripOutfitId/wear`,
    { schema: { params: TripOutfitParams } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id, tripOutfitId } = request.params;
      const at = new Date();
      const day = todayIn(config.timeZone, at);
      const wore = await wearTripOutfit(
        db,
        actor,
        { tripId: id, tripOutfitId },
        { at, today: day },
      );
      const { entryId, scheduled, worn } = wore.worn;
      logger.info(
        `Trip ${id} outfit ${wore.outfitId} worn by user ${actor.userId} on ${day} (${wore.occasion}): entry ${entryId} ${scheduled === 'scheduled' ? 'planned' : 'already planned'}, ${worn.changed ? `marked worn (${worn.wears} wears logged)` : 'already worn'}`,
      );
      return backToTrip(reply, id, dayAnchor(wore.day));
    },
  );

  // ---- Packing ----------------------------------------------------------------

  /**
   * A checklist's autosave (the packing list, the extras): the posted ticks
   * through the list's writer, logged, then a replay's 204 (#178: both are
   * queueable, `changed` when a tick moved) or the list's own answer.
   */
  function checklistRoute<Change extends PackedChange>(route: {
    path: string;
    kind: 'packed' | 'item';
    list: string;
    write: (actor: Actor, ticks: ChecklistTicks) => Promise<Change>;
    answer: (
      request: FastifyRequest,
      reply: FastifyReply,
      trip: { id: number; actor: Actor; change: Change },
    ) => FastifyReply | Promise<FastifyReply>;
  }) {
    app.post(
      route.path,
      {
        config: { queueable: route.kind },
        schema: { params: TripParams, body: ChecklistBody },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const { id } = request.params;
        const { packed = [], shown } = request.body ?? {};
        const change = await route.write(actor, {
          tripId: id,
          packed,
          unpacked: unchecked(shown, packed),
        });
        logger.info(
          `Trip ${id} ${route.list} set by user ${actor.userId}: ${change.packed} packed, ${change.unpacked} unpacked${replayNote(request)}`,
        );
        if (isReplay(request)) {
          return answerReplay(reply, change.packed + change.unpacked > 0);
        }
        return route.answer(request, reply, { id, actor, change });
      },
    );
  }

  // The packing list's AutosaveForm: the status line and the summary out of
  // band; a plain post comes back to the list.
  checklistRoute({
    path: `${TRIPS_PATH}/:id/packed`,
    kind: 'packed',
    list: 'packing',
    write: (actor, ticks) => packTrip(db, actor, ticks),
    answer: async (request, reply, { id, actor }) => {
      if (!request.headers['hx-request']) return backToTrip(reply, id);
      // Deleted since the write (another tab): the status line alone.
      const model = await tripModel(db, actor.userId, id, today());
      return renderFragment(
        reply,
        <>
          <AutosaveSaved />
          {model && <PackedSummary packing={model.packing} oob />}
        </>,
      );
    },
  });

  // ---- Extras -----------------------------------------------------------------

  app.post(
    `${TRIPS_PATH}/:id/items`,
    { schema: { params: TripParams, body: ItemBody } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const added = await addTripItem(db, actor, id, request.body.label);
      logger.info(
        `Trip ${id} extra ${added > 0 ? 'added' : 'already there'} by user ${actor.userId}`,
      );
      return backToTrip(reply, id, 'extras');
    },
  );

  // The extras' AutosaveForm: its summary comes from the write itself.
  checklistRoute({
    path: `${TRIPS_PATH}/:id/items/packed`,
    kind: 'item',
    list: 'extras',
    write: (actor, ticks) => packTripItems(db, actor, ticks),
    answer: (request, reply, { id, change }) => {
      if (!request.headers['hx-request']) {
        return backToTrip(reply, id, 'extras');
      }
      return renderFragment(
        reply,
        <>
          <AutosaveSaved />
          <ItemsSummary items={change.items} oob />
        </>,
      );
    },
  });

  app.post(
    `${TRIPS_PATH}/:id/items/:itemId/delete`,
    { schema: { params: TripItemParams } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id, itemId } = request.params;
      await removeTripExtra(db, actor, { tripId: id, itemId });
      logger.info(`Trip ${id} extra ${itemId} removed by user ${actor.userId}`);
      return backToTrip(reply, id, 'extras');
    },
  );

  app.post(
    `${TRIPS_PATH}/:id/items/copy`,
    { schema: { params: TripParams, body: CopyItemsBody } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const { from } = request.body;
      const copied = await copyTripExtras(db, actor, {
        fromTripId: from,
        toTripId: id,
      });
      logger.info(
        `Trip ${id}: ${copied} extra(s) copied from trip ${from} by user ${actor.userId}`,
      );
      return reply.redirect(tripUrl(id, `?copied=${copied}#extras`), 303);
    },
  );

  // ---- The destination's weather (WEATHER_ENABLED only) ---------------------------

  if (weather) {
    // The new-trip form's destination picker (#684, DestinationPicker):
    // fragments swapped into the form, writing nothing. Each carries a place
    // in its query, so none is logged (secretPath). A destination the
    // search does not take (PlaceQuery's bounds) is URL state: no places,
    // never a 400 htmx would not show.
    app.get(
      NEW_TRIP_PLACES_PATH,
      {
        schema: { querystring: NewTripPlacesQuery },
        config: { rateLimit: WEATHER_SEARCH_LIMIT, secretPath: true },
      },
      async (request, reply) => {
        const q = request.query.destination.trim();
        const answer =
          q.length < PLACE_QUERY_MIN || q.length > PLACE_QUERY_MAX
            ? { places: [] }
            : await placeAnswer(weather, { q });
        return renderFragment(reply, <NewTripPlaceResults answer={answer} />);
      },
    );

    app.get(
      NEW_TRIP_PLACE_PATH,
      {
        schema: { querystring: PlaceBody },
        config: { secretPath: true },
      },
      (request, reply) =>
        renderFragment(
          reply,
          <DestinationPicker
            destination=""
            place={pickedPlace(request.query)}
          />,
        ),
    );

    app.get(
      NEW_TRIP_DESTINATION_PATH,
      {
        schema: { querystring: NewTripDestinationQuery },
        config: { secretPath: true },
      },
      (request, reply) =>
        renderFragment(
          reply,
          <DestinationPicker
            destination={request.query.destination ?? ''}
            place={null}
          />,
        ),
    );

    // Always a fragment: the trip page loads it in place.
    app.get(
      `${TRIPS_PATH}/:id/weather`,
      { schema: { params: TripParams } },
      async (request, reply) => {
        const actor = actorOf(request);
        const trip = await requireTrip(db, actor, request.params.id);
        const now = new Date();
        const forecast = await tripForecast(
          { db, weather },
          actor.userId,
          trip,
          todayIn(config.timeZone, now),
        );
        return renderFragment(
          reply,
          <TripWeather
            tripId={trip.id}
            forecast={forecast}
            timeZone={config.timeZone}
            now={now}
          />,
        );
      },
    );

    app.get(
      `${TRIPS_PATH}/:id/places`,
      {
        schema: {
          params: TripParams,
          querystring: PlaceQuery,
        },
        config: { rateLimit: WEATHER_SEARCH_LIMIT, secretPath: true },
      },
      async (request, reply) => {
        const { id } = request.params;
        await requireTrip(db, actorOf(request), id);
        return renderFragment(
          reply,
          <TripPlaceResults
            tripId={id}
            answer={await placeAnswer(weather, request.query)}
          />,
        );
      },
    );

    app.post(
      `${TRIPS_PATH}/:id/destination`,
      {
        schema: { params: TripParams, body: PlaceBody },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        await enforceLimit(weatherLimits.destination, request, {
          logger,
          who: `user ${actor.userId}`,
        });
        const { id } = request.params;
        await locateTrip(db, actor, id, pickedPlace(request.body));
        // The user, never the place: where someone travels is theirs.
        logger.info(`Trip ${id} destination located by user ${actor.userId}`);
        return backToTrip(reply, id);
      },
    );
  }

  done();
};

/** A refused post's values, as the form shows them again. */
function formValues(body: TripBody): TripFormModel['values'] {
  return {
    name: body.name,
    destination: body.destination ?? '',
    startsOn: body.startsOn,
    endsOn: body.endsOn,
    notes: body.notes ?? '',
  };
}
