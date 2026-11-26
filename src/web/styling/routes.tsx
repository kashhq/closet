import { t } from '../i18n';
import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import { type Static, Type } from '@sinclair/typebox';
import { GARMENT_ROLES } from '../../wardrobe/properties';
import { sessionUserId } from '../auth/require-session';
import { todayIn } from '../../calendar-date';
import type { CapsuleRef } from '../capsules/queries';
import { HttpError } from '../errors';
import { dailySeed, parseSeed, shuffledSeed } from '../gallery/ideas';
import { postedDestination } from '../gallery/pick';
import {
  DestinationBody,
  DestinationQuery,
  parseDestination,
} from '../outfits/destination';
import { OutfitGarmentsGone, OutfitIncomplete } from '../outfits/gone-garments';
import { OUTFIT_NAME_MAX } from '../outfits/queries';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import { IsoDateSchema, OccasionSchema, OwnerQuery, RowId } from '../schemas';
import {
  actorOf,
  type WardrobeRequest,
  wardrobeGuard,
} from '../sharing/access';
import { brokenRuleLabels } from '../style/labels';
import { viewContext } from '../view-context';
import {
  describeScope,
  heldIdsOf,
  pageModel,
  postedState,
  refusalReason,
  returnToOf,
  type Scope,
} from './model';
import {
  MAX_ROWS,
  type RoleWindow,
  type RowState,
  shuffledStates,
  stylingRows,
  withEveryRole,
} from './rows';
import {
  type RoledGarment,
  roleGarmentsPage,
  type StripKeyset,
} from './queries';
import {
  addStylingRow,
  openStyling,
  refusedOpening,
  saveStyled,
  shuffleStyling,
  type StylingSave,
  stylingFit,
} from './styling-actions';
import {
  ScopeMenu,
  StylingPage,
  FitLine,
  StylingFit,
  StylingPreview,
  StylingRows,
} from './styling-page';
import { type RowContext, StripPage } from './styling-row';
import {
  STYLING_FIT_PATH,
  STYLING_GARMENTS_PATH,
  STYLING_PATH,
  STYLING_ROW_PATH,
  STYLING_SHUFFLE_PATH,
} from './urls';

/**
 * Styling (#42): the outfit composer that replaced the builder. The page,
 * its strips' next pages, Shuffle, "Add row" and Save. This file parses,
 * calls and renders (#719): the reads and Save are styling-actions.ts, the
 * page's model model.ts.
 *
 * Whose wardrobe: `?ownerId=` browses a wardrobe shared with the requester
 * (authorizeWardrobe, view: a stranger's is a 404), with its capsules; its
 * Shuffle sees only what the share shows (browseIdea). Nothing over a
 * shared wardrobe saves: outfits are private and hold only their owner's
 * garments, so Save takes the requester's own garments alone (a grantee
 * posting the owner's is a 404, nothing written). A saved outfit
 * (`?outfit=`) is the requester's own, and opens in their own wardrobe.
 *
 * Validation, decided per parameter:
 * - `?for=`, `?occasion=`, `?replace=`, `?seed=` and `?returnTo=` are
 *   navigation state: parseDestination and parseSeed fall back (no
 *   destination, the day's seed), returnTo goes through safeReturnTo. A
 *   `for=trip:ID` that is not the requester's trip is a 404 (aimIdeas).
 * - `?capsule=`, `?with=`, `?outfit=` and `?ownerId=` name data: not an
 *   id is a 400; a capsule outside the wardrobe, a garment not in its
 *   closet or another's outfit is a 404.
 * - `?picks=1` (Include picks, #335) is a toggle: anything else is off. It
 *   is the requester's own wardrobe's and never with a destination
 *   (scopeOf); elsewhere it is ignored. An old `?plan=` is ignored too.
 * - The rows Shuffle and "Add row" post back (`role`, `garmentId`, `lock`,
 *   one of each per row) are the page's own: lists of unequal length are
 *   a 400, and a garment that is not the wardrobe's is dropped from its row.
 * - Save's post is data: malformed is a 400 and writes nothing; `for`
 *   must read back as posted (postedDestination). A garment it cannot
 *   hold (archived for a new outfit, deleted, not the requester's) refuses
 *   the whole save (OutfitGarmentsGone, #219): the page again, its rows
 *   and sheet as posted, those rows back to "No garment" and the garments
 *   named, with the refusal's status (409, or 404 for one not theirs).
 */

const RoleSchema = Type.Union(GARMENT_ROLES.map((role) => Type.Literal(role)));

const PageQuery = Type.Object({
  ...DestinationQuery,
  capsule: Type.Optional(RowId),
  picks: Type.Optional(Type.String()),
  with: Type.Optional(RowId),
  outfit: Type.Optional(RowId),
  ...OwnerQuery.properties,
  returnTo: Type.Optional(Type.String()),
});

// The rows as the page posts them back (Shuffle, "Add row"): one role,
// garmentId and lock per row, in document order.
const RowFields = {
  role: Type.Optional(Type.Array(RoleSchema, { maxItems: MAX_ROWS })),
  garmentId: Type.Optional(
    Type.Array(Type.Union([Type.Literal(''), RowId]), { maxItems: MAX_ROWS }),
  ),
  lock: Type.Optional(
    Type.Array(Type.Union([Type.Literal(''), Type.Literal('1')]), {
      maxItems: MAX_ROWS,
    }),
  ),
};

const RowsQuery = Type.Object({
  ...PageQuery.properties,
  ...RowFields,
  seed: Type.Optional(Type.String()),
  // "Add row": the role of the row to add.
  add: Type.Optional(RoleSchema),
});

// A strip page is older garments (`before`) or newer ones (`after`, #996),
// never both: the oneOf makes either alone the only valid query.
const GarmentsQuery = Type.Object(
  {
    role: RoleSchema,
    before: Type.Optional(RowId),
    after: Type.Optional(RowId),
    capsule: Type.Optional(RowId),
    // Carried by the sentinel's link like the capsule, and unused: picks are
    // on a strip's first window alone.
    picks: Type.Optional(Type.String()),
    ...OwnerQuery.properties,
  },
  { oneOf: [{ required: ['before'] }, { required: ['after'] }] },
);

const SaveBody = Type.Object({
  ...RowFields,
  ...DestinationBody,
  name: Type.Optional(Type.String({ maxLength: OUTFIT_NAME_MAX })),
  outfit: Type.Optional(RowId),
  // The page's capsule: read only to show the page again when Save is refused.
  capsule: Type.Optional(RowId),
  // Include picks: a new outfit's Save is a slot write (saveWithPicks).
  picks: Type.Optional(Type.String()),
  // The sheet's "Add to calendar" without a destination; '' when left empty.
  scheduleDate: Type.Optional(Type.Union([Type.Literal(''), IsoDateSchema])),
  scheduleOccasion: Type.Optional(OccasionSchema),
  returnTo: Type.Optional(Type.String()),
});

type RowsInput = Static<typeof RowsQuery>;
type SaveInput = Static<typeof SaveBody>;

/** The rows a request posted back, as states; a 400 when the lists do not line up. */
function postedStates(query: RowsInput): RowState[] {
  const roles = query.role ?? [];
  const garmentIds = query.garmentId ?? [];
  const locks = query.lock ?? [];
  if (garmentIds.length !== roles.length || locks.length !== roles.length) {
    throw new HttpError(400, t('refusal.styling.rows'));
  }
  return roles.map((role, i) => ({
    role,
    garmentId: garmentIds[i] === '' ? null : garmentIds[i],
    locked: locks[i] === '1',
  }));
}

/**
 * Save's rows as states when the post carries the page's rows (a role and
 * a lock per garment id); undefined for a hand-made post of ids alone.
 */
function savedStates(body: SaveInput): RowState[] | undefined {
  const { role, garmentId, lock } = body;
  if (
    !role ||
    role.length !== garmentId?.length ||
    role.length !== lock?.length
  ) {
    return undefined;
  }
  return postedStates({ role, garmentId, lock });
}

/**
 * Save's post as the action takes it: the garment ids once each, blanks
 * ("No garment") left out, at least one (else a 400, before the
 * destination is judged); the name trimmed, blank as none.
 */
function stylingSave(body: SaveInput): StylingSave {
  const garmentIds = [
    ...new Set((body.garmentId ?? []).filter((id) => id !== '')),
  ];
  if (garmentIds.length === 0) {
    throw new HttpError(400, t('refusal.styling.nothingChosen'));
  }
  return {
    garmentIds,
    name: body.name?.trim() || undefined,
    destination: postedDestination(body),
    outfitId: body.outfit,
    picks: body.picks === '1',
    scheduleDate: body.scheduleDate || undefined,
    scheduleOccasion: body.scheduleOccasion,
    returnTo: body.returnTo,
  };
}

function ids(garments: readonly { id: number }[]): number[] {
  return garments.map((g) => g.id);
}

/** `?ownerId=` names a wardrobe other than the requester's own. */
function isOther(ownerId: number | '' | undefined, userId: number): boolean {
  return ownerId !== undefined && ownerId !== '' && ownerId !== userId;
}

export const stylingRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger, weather },
  done,
) => {
  const authorize = wardrobeGuard(db, 'wardrobe');
  const readDeps = { db, weather };

  /**
   * The wardrobe a request addresses (its own, or one shared with the
   * requester, 404 otherwise), with the capsule it names: the reads check
   * that (reads.ts; a 404 outside it, styling-actions.ts).
   */
  async function scopeOf(
    request: WardrobeRequest & {
      query: {
        capsule?: number;
        picks?: string;
        outfit?: number;
        for?: string;
        occasion?: string;
        replace?: string;
      };
    },
  ): Promise<Scope> {
    const { query } = request;
    const { access, viewOwner } = await authorize(request, 'view');
    const picksOffered =
      viewOwner === undefined && parseDestination(query).kind === 'none';
    return {
      userId: sessionUserId(request),
      ownerId: access.ownerId,
      shared: viewOwner !== undefined,
      viewOwner,
      capsuleId: query.capsule,
      // Picks are the requester's own, and never offered while the page
      // picks for a day or a trip: an incomplete outfit is never planned.
      picksOffered,
      picks: picksOffered && query.picks === '1',
      // Neither are outfits: over a shared wardrobe there is no edit.
      editingOutfitId: viewOwner === undefined ? query.outfit : undefined,
    };
  }

  function today() {
    return todayIn(config.timeZone, new Date());
  }

  app.get(
    STYLING_PATH,
    { schema: { querystring: PageQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { query } = request;
      const day = today();
      const scope = await scopeOf(request);
      const opening = await openStyling(
        readDeps,
        actorOf(request),
        scope,
        {
          ...query,
          // A saved outfit is the requester's: over a shared wardrobe, a 404.
          outfitId: isOther(query.ownerId, userId) ? undefined : query.outfit,
        },
        day,
      );
      const model = pageModel(opening, returnToOf(query.returnTo));
      const { wardrobe, opened, styled } = opening;
      logger.debug(
        `Styling for user ${userId}: ${model.rows.length} row(s), ${describeScope(wardrobe, opened)}${styled.missed ? ', no idea fits' : ''}`,
      );
      return renderPage(
        reply,
        <StylingPage ctx={viewContext(reply)} model={model} />,
      );
    },
  );

  /**
   * Shuffle, "Add row" and the Include picks switch answer the rows, with
   * what the page carries on and the preview drawn from them.
   */
  function renderRows(
    reply: FastifyReply,
    input: {
      states: RowState[];
      windows: RoleWindow[];
      held: RoledGarment[];
      seed?: number;
      notice?: 'no-idea';
      broken?: string[];
      context: RowContext;
      /**
       * The capsule menu again, out of band: "Add row" and the Include
       * picks switch answer here, and the switch changes the state the
       * menu's links carry (ScopeMenu).
       */
      scope?: { capsule: CapsuleRef | undefined; capsules: CapsuleRef[] };
    },
  ) {
    const rows = stylingRows(
      withEveryRole(input.states, input.windows),
      input.windows,
      input.held,
    );
    return renderFragment(
      reply,
      <>
        <StylingRows
          model={{
            rows,
            seed: input.seed,
            notice: input.notice,
            broken: input.broken,
          }}
          context={input.context}
        />
        {/* The preview follows the rows (StylingPreview): out of band, as
            its slots are the rows' and the page keeps it beside them. */}
        <StylingPreview rows={rows} oob />
        {/* A fresh fit slot loads the line again for the new rows. */}
        {weather && input.context.viewOwner === undefined && <StylingFit oob />}
        {input.scope && (
          <ScopeMenu {...input.scope} state={input.context.state} oob />
        )}
      </>,
    );
  }

  // Shuffle: the generator fills the unlocked rows; a GET, as it reads.
  app.get(
    STYLING_SHUFFLE_PATH,
    { schema: { querystring: RowsQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { query } = request;
      const started = performance.now();
      const day = today();
      const scope = await scopeOf(request);
      const posted = postedStates(query);
      const seed = parseSeed(query.seed) ?? dailySeed(day);
      const shuffled = await shuffleStyling(
        readDeps,
        actorOf(request),
        scope,
        { ...query, posted, seed },
        day,
      );
      const { wardrobe, idea, lockedIds } = shuffled;
      const { windows } = shuffled.strips;
      const rows = withEveryRole(shuffled.states, windows);
      logger.debug(
        `Styling shuffle for user ${userId} over ${describeScope(wardrobe)}: ${lockedIds.length} locked, seed ${seed}, ${idea ? `idea of garments ${ids(idea.garments).join(', ')}` : 'no idea fits'}${idea?.brokenRules.length ? `, the locks breaking ${idea.brokenRules.length} rule(s)` : ''} in ${Math.round(performance.now() - started)} ms`,
      );
      return renderRows(reply, {
        states: idea ? shuffledStates(rows, idea.garments) : rows,
        windows,
        held: shuffled.held,
        seed: shuffledSeed(seed),
        notice: idea ? undefined : 'no-idea',
        broken: idea && brokenRuleLabels(idea),
        context: {
          state: postedState(query, wardrobe),
          viewOwner: wardrobe.viewOwner,
          picksOffered: wardrobe.picksOffered,
        },
      });
    },
  );

  // "Add row": the rows again, one more (empty) of the role asked for.
  app.get(
    STYLING_ROW_PATH,
    { schema: { querystring: RowsQuery } },
    async (request, reply) => {
      const { query } = request;
      const scope = await scopeOf(request);
      const posted = postedStates(query);
      const { wardrobe, states, reads } = await addStylingRow(
        db,
        scope,
        posted,
        query.add,
      );
      return renderRows(reply, {
        states,
        windows: reads.windows,
        held: reads.held,
        seed: parseSeed(query.seed),
        context: {
          state: postedState(query, wardrobe),
          viewOwner: wardrobe.viewOwner,
          picksOffered: wardrobe.picksOffered,
        },
        scope: { capsule: wardrobe.capsule, capsules: reads.capsules },
      });
    },
  );

  // The fit line (#468b): how the posted rows' outfit meets the aimed day's
  // weather, for the page's `?for=` as Shuffle aims it (aimIdeas: today all
  // day without one, a trip's day and destination). Only with
  // WEATHER_ENABLED, like /weather/*: no route without it. Nothing over a
  // shared wardrobe (browseIdea reads none of the owner's weather), without
  // a garment, or without a forecast for the day. The rows are checked as
  // Shuffle's are (a 400 when they do not line up; a garment the rows may
  // not carry is left out); the capsule is not read, as nothing here
  // depends on it. It writes nothing.
  if (weather) {
    app.get(
      STYLING_FIT_PATH,
      { schema: { querystring: RowsQuery } },
      async (request, reply) => {
        const userId = sessionUserId(request);
        const { query } = request;
        const posted = postedStates(query);
        const scope = await scopeOf(request);
        const heldIds = heldIdsOf(posted);
        if (scope.shared || heldIds.length === 0) {
          return renderFragment(reply, <FitLine />);
        }
        const now = new Date();
        const { fit, garments, aim } = await stylingFit(
          { db, weather },
          actorOf(request),
          scope,
          { ...query, heldIds },
          now,
          todayIn(config.timeZone, now),
        );
        logger.debug(
          `Styling fit for user ${userId}: ${garments} garment(s) for ${aim.planning.day} (${aim.planning.occasion}), ${fit ? fit.problems.join(', ') || 'fits' : 'no weather'}`,
        );
        return renderFragment(reply, <FitLine fit={fit} />);
      },
    );
  }

  // A strip's next page (its sentinel). Always a fragment. The capsule
  // needs no lookup here: inCapsule matches none of the wardrobe's
  // garments for a capsule of another (AGENTS.md, Gotchas).
  app.get(
    STYLING_GARMENTS_PATH,
    { schema: { querystring: GarmentsQuery } },
    async (request, reply) => {
      const { role, before, after, capsule, picks } = request.query;
      const { access, viewOwner } = await authorize(request, 'view');
      // GarmentsQuery's oneOf: exactly one of the two is here.
      const keyset: StripKeyset =
        after === undefined ? { before: before! } : { after };
      const page = await roleGarmentsPage(db, access.ownerId, role, {
        capsuleId: capsule,
        keyset,
      });
      return renderFragment(
        reply,
        <StripPage
          role={role}
          keyset={keyset}
          garments={page.garments}
          more={page.more}
          context={{
            state: {
              capsuleId: capsule,
              picks: viewOwner === undefined && picks === '1',
              ownerId: viewOwner,
            },
            viewOwner,
          }}
        />,
      );
    },
  );

  // Save (the sheet's native post; saveStyled). Refused for a garment it
  // cannot hold: the page again, as posted, with the refusal's status.
  app.post(
    STYLING_PATH,
    { schema: { body: SaveBody } },
    async (request, reply) => {
      const { body } = request;
      const actor = actorOf(request);
      const save = stylingSave(body);
      try {
        const landing = await saveStyled({ db, logger }, actor, save);
        return reply.redirect(landing, 303);
      } catch (error) {
        const states = savedStates(body);
        const refused =
          error instanceof OutfitGarmentsGone ||
          error instanceof OutfitIncomplete;
        if (!refused || !states) throw error;
        logger.info(
          `Styling save by user ${actor.userId} refused (${error.statusCode}): ${refusalReason(error)}${body.outfit === undefined ? '' : ` for outfit ${body.outfit}`}; the page again`,
        );
        const opening = await refusedOpening(
          db,
          actor,
          { error, states },
          {
            posted: save,
            capsuleId: body.capsule,
            draft: {
              name: body.name,
              scheduleDate: body.scheduleDate || undefined,
              scheduleOccasion: body.scheduleOccasion,
            },
          },
          today(),
        );
        return renderPage(
          reply,
          <StylingPage
            ctx={viewContext(reply)}
            model={pageModel(opening, returnToOf(body.returnTo))}
          />,
          { status: error.statusCode },
        );
      }
    },
  );

  done();
};
