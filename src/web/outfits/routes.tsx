import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Static, Type } from '@sinclair/typebox';
import { sessionUserId } from '../auth/require-session';
import { parseIsoDate, todayIn } from '../../calendar-date';
import { pickDestination } from '../calendar/day-choice';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { navigateTo, renderFragment, renderPage } from '../render';
import { DEFAULT_OCCASION } from '../../wardrobe/occasions';
import { IsoDateSchema, OccasionSchema, RowId } from '../schemas';
import { alreadySavedOf, alreadySavedParam } from '../gallery/urls';
import { stylingUrl } from '../styling/urls';
import { viewContext } from '../view-context';
import {
  DestinationQuery,
  type OutfitDestination,
  parseDestination,
} from './destination';
import { OutfitsPage, SavedTiles } from './list-page';
import { OUTFIT_PAGE_SIZE } from './page-size';
import { OutfitListQuery, parseOutfitList } from './outfit-list';
import {
  editOutfit,
  reactToProposal,
  removeOutfit,
  requireOutfitPage,
  setOutfitPublicShare,
} from './outfit-actions';
import { savedContext } from './page-context';
import {
  createOutfit,
  type CreateResult,
  FIRST_OUTFIT_PAGE,
  OUTFIT_NAME_MAX,
  OUTFIT_NOTES_MAX,
  OUTFIT_SLOTS_MAX,
  type OutfitInput,
  outfitText,
  type SaveResult,
} from './queries';
import {
  DECLINE_NOTE_MAX,
  OutfitCursor,
  OutfitParams,
  SlotCategory,
} from './schemas';
import { OutfitPage } from './show-page';
import { outfitUrl, SAVED_TILES_PATH } from './urls';
import type { OutfitReaction } from './reactions';
import { OUTFIT_DISMISS_REASONS } from '../../wardrobe/suggestions';
import { actorOf } from '../sharing/access';
import { safeReturnTo } from '../security/return-to';
import {
  DECISION_FLAG,
  type DecisionToast,
  decisionToastOf,
} from '../wishlist/suggestion-parts';
import { withParams } from '../wardrobe/urls';
import { BY_PERSON } from '../write-origin';

/**
 * Validation, decided per route:
 * - The builder's old addresses (`/outfits/new`, `/outfits/:id/edit`) only
 *   redirect into Styling, carrying what they meant: navigation state, so
 *   anything malformed is dropped rather than refused (`?for=` through
 *   parseDestination, `?scheduleDate=` from calendar pages cached before
 *   #13 through parseIsoDate, `?capsule=` and `?returnTo=` passed on for
 *   Styling to judge).
 * - The outfit form's post (POST /outfits, /outfits/:id: pages the
 *   installed app cached before Styling, and the specs' fixtures) is data
 *   the write stores: anything malformed is a 400 and writes nothing. An
 *   empty date input posts '' (no schedule); no occasion (a form cached
 *   before #13) is all day.
 * - GET /outfits reads ?for=, ?occasion= and ?replace= as navigation state
 *   (parseDestination, as the plan page does): no day is the plain grid, an
 *   unknown occasion all day, and a `replace` that is not the user's
 *   unworn entry there picks one more outfit. POST /calendar checks again.
 */

/** One outfit's route: its page, its save and its delete; Share and Stop sharing are under it. */
const OUTFIT_ROUTE = '/outfits/:id';

// A date input left empty posts ''.
const OptionalDay = Type.Union([Type.Literal(''), IsoDateSchema]);

// The builder's links: the calendar's plan page (`?for=`), calendar pages
// cached before #13 (`?scheduleDate=`), a capsule's "Build an outfit", and
// the edit links (`?returnTo=/calendar&returnToWeek=`).
const BuilderLinkQuery = Type.Object({
  returnTo: Type.Optional(Type.String()),
  ...DestinationQuery,
  scheduleDate: Type.Optional(Type.String()),
  returnToWeek: Type.Optional(Type.String()),
  capsule: Type.Optional(Type.String()),
});

// The Saved tab picking for a day (`?for=day:D&occasion=O[&replace=E]`,
// R5) and its list (`?show=one-offs`, #659): navigation state, read by
// parseDestination and parseOutfitList (anything malformed is the plain
// kept grid, a trip too: trips add outfits on their own page).
const SavedQuery = Type.Object({
  ...DestinationQuery,
  ...OutfitListQuery,
  [DECISION_FLAG]: Type.Optional(Type.String({ maxLength: 16 })),
});

// The Saved grid's next page (#660): the page's own navigation state, and
// the keyset cursor its sentinel names (a malformed one is a 400: only our
// sentinel builds it).
const SavedTilesQuery = Type.Object({
  ...DestinationQuery,
  ...OutfitListQuery,
  before: OutfitCursor,
});

// The gallery's pick lands here with `alreadySaved=1` when the outfit
// existed (a one-shot flag: anything else is no toast); a reaction with
// its toast (`decided=`).
const FlagQuery = Type.Object({
  alreadySaved: Type.Optional(Type.String()),
  [DECISION_FLAG]: Type.Optional(Type.String({ maxLength: 16 })),
});

/** Where a reaction comes back to: the page it was made on (safeReturnTo). */
const ReactionBody = Type.Union([
  Type.Object({ returnTo: Type.Optional(Type.String({ maxLength: 2048 })) }),
  Type.Null(),
]);

/** "Not for me" on one of Muse's outfits: a reason (a 400 without), an optional note. */
const DeclineBody = Type.Object({
  returnTo: Type.Optional(Type.String({ maxLength: 2048 })),
  reason: Type.Union(
    OUTFIT_DISMISS_REASONS.map((reason) => Type.Literal(reason)),
  ),
  note: Type.Optional(Type.String({ maxLength: DECLINE_NOTE_MAX })),
});

// The form posts one category + garmentId pair per row, in row order (a
// single row arrives as scalars; ajv's coerceTypes: 'array' makes them
// one-element arrays). garmentId '' is a row without a garment. Absent
// fields: an update leaves name and notes as they are; no rows is an empty
// outfit.
const OutfitBody = Type.Object({
  name: Type.Optional(Type.String({ maxLength: OUTFIT_NAME_MAX })),
  notes: Type.Optional(Type.String({ maxLength: OUTFIT_NOTES_MAX })),
  category: Type.Optional(
    Type.Array(SlotCategory, { maxItems: OUTFIT_SLOTS_MAX }),
  ),
  garmentId: Type.Optional(
    Type.Array(Type.Union([Type.Literal(''), RowId]), {
      maxItems: OUTFIT_SLOTS_MAX,
    }),
  ),
  scheduleDate: Type.Optional(OptionalDay),
  scheduleOccasion: Type.Optional(OccasionSchema),
  returnTo: Type.Optional(Type.String()),
  returnToWeek: Type.Optional(OptionalDay),
});

type OutfitForm = Static<typeof OutfitBody>;

/** The form's rows and fields: an edit as posted, a create once its origin is said. */
function outfitInput(body: OutfitForm): Omit<OutfitInput, 'origin' | 'madeBy'> {
  const categories = body.category ?? [];
  const garmentIds = body.garmentId ?? [];
  if (categories.length !== garmentIds.length) {
    throw new HttpError(
      400,
      'Each outfit row needs a category and a garment id (empty for none)',
    );
  }
  return {
    name: outfitText(body.name),
    notes: outfitText(body.notes),
    slots: categories.map((category, i) => ({
      category,
      garmentId: garmentIds[i] === '' ? null : garmentIds[i],
    })),
    plan: body.scheduleDate
      ? {
          day: body.scheduleDate,
          occasion: body.scheduleOccasion ?? DEFAULT_OCCASION,
        }
      : undefined,
  };
}

/**
 * Where an old builder link meant a new outfit to go: `?for=`, else a
 * `?scheduleDate=` from a calendar page cached before #13 (all day).
 */
function linkedDestination(
  query: Static<typeof BuilderLinkQuery>,
): OutfitDestination {
  const destination = parseDestination(query);
  if (destination.kind !== 'none') return destination;
  const day = parseIsoDate(query.scheduleDate);
  return day
    ? { kind: 'day', day, occasion: DEFAULT_OCCASION }
    : { kind: 'none' };
}

/**
 * The edit links' way back: the calendar week they came from
 * (`returnTo=/calendar&returnToWeek=`), else `returnTo` as it was.
 */
function linkedReturnTo(
  query: Static<typeof BuilderLinkQuery>,
): string | undefined {
  const week = parseIsoDate(query.returnToWeek);
  return query.returnTo === '/calendar' && week
    ? `/calendar?week=${week}`
    : query.returnTo;
}

/**
 * Where a saved form goes: back to the calendar week it came from, else the
 * outfit; either says "Already saved" when the garments were an outfit
 * already (createOutfit reused it, ALREADY_SAVED_FLAG).
 */
function afterSave(
  body: OutfitForm,
  id: number,
  saved: { alreadySaved: boolean; adoptedProposal: boolean } = {
    alreadySaved: false,
    adoptedProposal: false,
  },
): string {
  const flag = alreadySavedParam(saved);
  if (body.returnTo === '/calendar') {
    const week = body.returnToWeek || body.scheduleDate;
    return week
      ? `/calendar?week=${week}${flag && `&${flag}`}`
      : `/calendar${flag && `?${flag}`}`;
  }
  return `/outfits/${id}${flag && `?${flag}`}`;
}

function describeSave(result: SaveResult, plan: OutfitInput['plan']): string {
  const parts = [`${result.slots} row(s)`];
  if (plan && result.schedule === 'scheduled') {
    parts.push(`scheduled on ${plan.day} (${plan.occasion})`);
  }
  if (plan && result.schedule === 'already-scheduled') {
    parts.push(`already scheduled on ${plan.day}`);
  }
  if (result.entriesClaimed) {
    parts.push(`${result.entriesClaimed} planned entry(ies) now the user's`);
  }
  return parts.join(', ');
}

/** The outfit form's create log line: a new outfit, or the one its garments already were. */
function createMessage(
  ownerId: number,
  result: CreateResult,
  plan: OutfitInput['plan'],
): string {
  const saved = describeSave(result, plan);
  if (!result.alreadySaved) {
    return `Outfit ${result.id} created by user ${ownerId}: ${saved}`;
  }
  const takenOver = result.adopted ? '; taken over from the week planner' : '';
  return `Outfit form by user ${ownerId}: its garments are already outfit ${result.id}, nothing created (${saved})${takenOver}`;
}

/**
 * /outfits: the list, the detail page, the writes, and the builder's old
 * addresses, now redirects into Styling (src/web/styling). Outfits are the signed-in user's own:
 * wardrobe shares never reach them, `?ownerId=` is ignored, and anyone
 * else's outfit id is a 404 like an unknown one.
 */
export const outfitRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { config, db, logger },
  done,
) => {
  app.get(
    '/outfits',
    { schema: { querystring: SavedQuery } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const today = todayIn(config.timeZone, new Date());
      const destination = parseDestination(request.query);
      if (destination.kind === 'trip') {
        logger.debug(
          `GET /outfits: a trip is not picked for here (user ${ownerId}), showing Saved`,
        );
      }
      const day = destination.kind === 'day' ? destination : undefined;
      const list = parseOutfitList(request.query.show);
      const { page, activity, choice, muse } = await savedContext(
        db,
        ownerId,
        today,
        day,
        list,
        FIRST_OUTFIT_PAGE,
      );
      if (day?.replace !== undefined && !choice?.replacing) {
        logger.debug(
          `GET /outfits: entry ${day.replace} is not user ${ownerId}'s on ${day.day} (${day.occasion}), picking another`,
        );
      }
      return renderPage(
        reply,
        <OutfitsPage
          ctx={viewContext(reply)}
          model={{
            ...page,
            list,
            activity,
            muse,
            toast: decisionToastOf(request.query[DECISION_FLAG]),
            picking:
              day && choice
                ? { destination: pickDestination(day, choice), choice }
                : undefined,
          }}
        />,
      );
    },
  );

  // The Saved grid's sentinel (hx-trigger="revealed", #660): the page below
  // `before` of the same list, picking for the same day, and the next
  // sentinel. Always a fragment; one statement after the session, as the tab.
  app.get(
    SAVED_TILES_PATH,
    { schema: { querystring: SavedTilesQuery } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const today = todayIn(config.timeZone, new Date());
      const destination = parseDestination(request.query);
      const day = destination.kind === 'day' ? destination : undefined;
      const list = parseOutfitList(request.query.show);
      const { before } = request.query;
      const { page, activity, choice } = await savedContext(
        db,
        ownerId,
        today,
        day,
        list,
        { before, limit: OUTFIT_PAGE_SIZE },
      );
      logger.debug(
        `GET ${SAVED_TILES_PATH}: ${page.outfits.length} ${list} outfits of user ${ownerId} below ${before}${page.next === null ? ', the last page' : ''}`,
      );
      return renderFragment(
        reply,
        <SavedTiles
          model={{
            ...page,
            list,
            activity,
            picking:
              day && choice
                ? { destination: pickDestination(day, choice), choice }
                : undefined,
          }}
          firstPage={false}
        />,
      );
    },
  );

  // The builder became Styling (#42): its links (the manifest's and
  // pages the installed app cached, the calendar's, a capsule's) land there
  // with what they meant; Styling judges the capsule (404 if not the
  // wardrobe's), and one that is not even an id is dropped.
  app.get(
    '/outfits/new',
    { schema: { querystring: BuilderLinkQuery } },
    async (request, reply) => {
      const { query } = request;
      const capsule = /^\d{1,10}$/.test(query.capsule ?? '')
        ? Number(query.capsule)
        : undefined;
      return reply.redirect(
        stylingUrl({
          destination: linkedDestination(query),
          capsuleId: capsule,
          returnTo: query.returnTo,
        }),
        302,
      );
    },
  );

  app.get(
    OUTFIT_ROUTE,
    { schema: { params: OutfitParams, querystring: FlagQuery } },
    async (request, reply) => {
      const today = todayIn(config.timeZone, new Date());
      const found = await requireOutfitPage(
        db,
        actorOf(request),
        request.params.id,
        today,
      );
      return renderPage(
        reply,
        <OutfitPage
          ctx={viewContext(reply)}
          outfit={found.outfit}
          entries={found.entries}
          today={today}
          alreadySaved={alreadySavedOf(request.query.alreadySaved)}
          toast={decisionToastOf(request.query[DECISION_FLAG])}
        />,
      );
    },
  );

  // Editing an outfit is Styling with it open (`?outfit=`), which checks
  // it is the requester's.
  app.get(
    '/outfits/:id/edit',
    { schema: { params: OutfitParams, querystring: BuilderLinkQuery } },
    async (request, reply) =>
      reply.redirect(
        stylingUrl({
          outfitId: request.params.id,
          returnTo: linkedReturnTo(request.query),
        }),
        302,
      ),
  );

  app.post(
    '/outfits',
    { schema: { body: OutfitBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const input = outfitInput(request.body);
      const result = await createOutfit(db, ownerId, {
        ...input,
        origin: 'person',
        madeBy: BY_PERSON,
      });
      logger.info(createMessage(ownerId, result, input.plan));
      return reply.redirect(afterSave(request.body, result.id, result), 302);
    },
  );

  app.post(
    OUTFIT_ROUTE,
    { schema: { params: OutfitParams, body: OutfitBody } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const input = outfitInput(request.body);
      const result = await editOutfit(db, actor, id, input);
      logger.info(
        `Outfit ${id} updated by user ${actor.userId}: ${describeSave(result, input.plan)}`,
      );
      return reply.redirect(afterSave(request.body, id), 302);
    },
  );

  /**
   * Share and Stop sharing the public link (#669; htmx hx-post from the ⋯
   * menu and the page's "Shared publicly" panel): the owner's. Back to the
   * outfit page, which shows the link, or no longer does.
   */
  async function changePublicShare(
    request: FastifyRequest & { params: { id: number } },
    reply: FastifyReply,
    shared: boolean,
  ): Promise<FastifyReply> {
    const actor = actorOf(request);
    const { id } = request.params;
    await setOutfitPublicShare(db, actor, id, shared);
    logger.info(
      `Outfit ${id} ${shared ? 'shared publicly' : 'no longer shared publicly'} by user ${actor.userId}`,
    );
    return navigateTo(reply, outfitUrl(id));
  }

  app.post(
    `${OUTFIT_ROUTE}/share`,
    { schema: { params: OutfitParams } },
    (request, reply) => changePublicShare(request, reply, true),
  );

  app.post(
    `${OUTFIT_ROUTE}/share/stop`,
    { schema: { params: OutfitParams } },
    (request, reply) => changePublicShare(request, reply, false),
  );

  // htmx only (hx-delete, hx-confirm): the page swaps to the list.
  app.delete(
    OUTFIT_ROUTE,
    { schema: { params: OutfitParams } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      const deleted = await removeOutfit(db, actor, id);
      logger.info(
        `Outfit ${id} deleted by user ${actor.userId} (${deleted.wearsKept} wears kept as day-level wears)`,
      );
      return navigateTo(reply, '/outfits');
    },
  );

  /**
   * A reaction to one of Muse's outfits (#335; reactToProposal over the one
   * writer): Love (Save on a complete outfit), Not for me with a reason,
   * Undo. A native post each, 303 to the page it was made on with its
   * toast; the refusals (a 404, a 409) are reactToProposal's.
   */
  async function reacted(
    request: FastifyRequest & { params: { id: number } },
    reply: FastifyReply,
    change: OutfitReaction,
    { returnTo, toast }: { returnTo: string | undefined; toast: DecisionToast },
  ) {
    const { id } = request.params;
    const actor = actorOf(request);
    const outcome = await reactToProposal(db, actor, id, change);
    logger.info(
      `Outfit ${id} ${outcome.from} -> ${outcome.to} by user ${actor.userId}${change.event === 'decline' ? ` (${change.reason})` : ''}`,
    );
    // Save once complete: the same move, said as what it did.
    const said = toast === 'love' && outcome.complete ? 'save' : toast;
    return reply.redirect(
      withParams(safeReturnTo(returnTo, '/outfits'), { [DECISION_FLAG]: said }),
      303,
    );
  }

  app.post(
    '/outfits/:id/love',
    { schema: { params: OutfitParams, body: ReactionBody } },
    async (request, reply) =>
      reacted(
        request,
        reply,
        { event: 'love' },
        { returnTo: request.body?.returnTo, toast: 'love' },
      ),
  );

  app.post(
    '/outfits/:id/dismiss',
    { schema: { params: OutfitParams, body: DeclineBody } },
    async (request, reply) => {
      const { body } = request;
      return reacted(
        request,
        reply,
        {
          event: 'decline',
          reason: body.reason,
          note: body.note?.trim() || null,
        },
        { returnTo: body.returnTo, toast: 'dismiss' },
      );
    },
  );

  app.post(
    '/outfits/:id/undo',
    { schema: { params: OutfitParams, body: ReactionBody } },
    async (request, reply) =>
      reacted(
        request,
        reply,
        { event: 'reconsider' },
        { returnTo: request.body?.returnTo, toast: 'undo' },
      ),
  );

  done();
};
