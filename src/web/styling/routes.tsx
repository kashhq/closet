import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Static, Type } from '@sinclair/typebox';
import type { Idea } from '../../wardrobe/generator';
import { DEFAULT_OCCASION, type Occasion } from '../../wardrobe/occasions';
import { assessOutfit } from '../../weather/match';
import { GARMENT_ROLES, type GarmentRole } from '../../wardrobe/properties';
import { sessionUserId } from '../auth/require-session';
import { type IsoDate, todayIn } from '../../calendar-date';
import type { CapsuleRef } from '../capsules/queries';
import { capsuleNotFound } from '../capsules/capsule-actions';
import { HttpError } from '../errors';
import { aimIdeas, type IdeasAim } from '../gallery/aim';
import { dailySeed, ideaName, parseSeed, shuffledSeed } from '../gallery/ideas';
import { pickTo, postedDestination } from '../gallery/pick';
import type { PoolGarment } from '../gallery/queries';
import {
  DestinationBody,
  DestinationQuery,
  type OutfitDestination,
  parseDestination,
} from '../outfits/destination';
import { alreadySavedParam } from '../gallery/urls';
import {
  describeGone,
  garmentsGoneError,
  OutfitGarmentsGone,
  OutfitIncomplete,
} from '../outfits/gone-garments';
import {
  editOutfit,
  outfitNotFound,
  saveOutfit,
} from '../outfits/outfit-actions';
import { OUTFIT_NAME_MAX } from '../outfits/queries';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import { IsoDateSchema, OccasionSchema, OwnerQuery, RowId } from '../schemas';
import { safeReturnTo } from '../security/return-to';
import {
  type Actor,
  actorOf,
  type WardrobeRequest,
  wardrobeGuard,
} from '../sharing/access';
import { brokenRuleLabels } from '../style/labels';
import { viewContext } from '../view-context';
import {
  MAX_ROWS,
  openingStates,
  type RoleWindow,
  type RowState,
  shuffledStates,
  type StylingRow,
  stylingRows,
  topToToe,
  withEveryRole,
} from './rows';
import {
  type Chosen,
  type RoledGarment,
  roleGarmentsPage,
  type SavedOutfit,
  savedGarments,
  type StripKeyset,
} from './queries';
import {
  fitReads,
  ideaReads,
  type StripsReads,
  stripsReads,
  type StylingScope,
} from './reads';
import {
  type SaveDraft,
  ScopeMenu,
  type StylingModel,
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
  type StylingState,
} from './urls';
import { garmentNotFound } from '../wardrobe/garment-access';
import { BY_PERSON } from '../write-origin';

/**
 * Styling (#42): the outfit composer that replaced the builder. The page,
 * its strips' next pages, Shuffle, "Add row" and Save.
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

/** The rows a request posted back, as states; a 400 when the lists do not line up. */
function postedStates(query: RowsInput): RowState[] {
  const roles = query.role ?? [];
  const garmentIds = query.garmentId ?? [];
  const locks = query.lock ?? [];
  if (garmentIds.length !== roles.length || locks.length !== roles.length) {
    throw new HttpError(400, 'Each row needs a role, a garment id and a lock');
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
function savedStates(body: Static<typeof SaveBody>): RowState[] | undefined {
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

/** The posted garment ids, once each, blanks ("No garment") left out. */
function chosenIds(posted: readonly (number | '')[] | undefined): number[] {
  return [...new Set((posted ?? []).filter((id) => id !== ''))];
}

function ids(garments: readonly { id: number }[]): number[] {
  return garments.map((g) => g.id);
}

/** `?ownerId=` names a wardrobe other than the requester's own. */
function isOther(ownerId: number | '' | undefined, userId: number): boolean {
  return ownerId !== undefined && ownerId !== '' && ownerId !== userId;
}

/** Back, and where a saved edit goes: a same-site path only, else none. */
function returnToOf(value: string | undefined): string | undefined {
  return safeReturnTo(value, '') || undefined;
}

/** The wardrobe a Styling request addresses, resolved. */
interface Wardrobe {
  ownerId: number;
  /** A shared wardrobe's owner (links carry it); undefined for one's own. */
  viewOwner: number | undefined;
  capsule?: CapsuleRef;
  /** Include picks is on (`?picks=1`, StylingScope.picks). */
  picks: boolean;
  /**
   * Include picks may be turned on here: one's own wardrobe, no
   * destination, and not an edit of a planned or packed outfit (which
   * takes no pick). The switch shows only then.
   */
  picksOffered: boolean;
}

/**
 * A request's scope (reads.ts) with the owner its links carry, and whether
 * Include picks may be offered before the reads (scopeOf).
 */
type Scope = StylingScope &
  Pick<Wardrobe, 'viewOwner'> & { picksOffered: boolean };

/**
 * The wardrobe once the reads checked its capsule and whether the outfit
 * the rows edit is held (StripsReads.editingHeld): then no pick. Nor
 * while the closet cannot be dressed as an outfit (StripsReads.canDress,
 * the first-run gate, #666), unless picks are on already, so the switch
 * is there to turn them off.
 */
function wardrobeOf(
  scope: Scope,
  capsule: CapsuleRef | undefined,
  { canDress, editingHeld }: Pick<StripsReads, 'canDress' | 'editingHeld'>,
): Wardrobe {
  const picks = scope.picks === true && !editingHeld;
  return {
    ownerId: scope.ownerId,
    viewOwner: scope.viewOwner,
    capsule,
    picks,
    picksOffered: scope.picksOffered && !editingHeld && (picks || canDress),
  };
}

/** What the page was opened with: a saved outfit (`?outfit=`), "Style this"'s garment (`?with=`). */
interface Opened {
  saved?: SavedOutfit;
  with?: { id: number; role: GarmentRole };
}

/** "Style this"'s opening idea (styledOpening); empty without `?with=`. */
interface StyledOpening {
  idea?: Idea<PoolGarment>;
  /** Shuffle's next seed. */
  seed?: number;
  /** Nothing fits around the garment: the page says so. */
  missed?: boolean;
}

/** What GET /styling read to open the page (plainOpening, styledOpening). */
interface Opening {
  wardrobe: Wardrobe;
  aim: IdeasAim;
  opened: Opened;
  styled: StyledOpening;
  reads: StripsReads;
}

/** The page's model from what the handler read. */
function pageModel(input: {
  wardrobe: Wardrobe;
  aim: IdeasAim;
  opened: Opened;
  styled: StyledOpening;
  windows: RoleWindow[];
  capsules: CapsuleRef[];
  /** The shared wardrobe's owner's name; undefined for one's own. */
  owner: string | undefined;
  returnTo: string | undefined;
  /** A refused Save: its rows as posted, instead of the opening ones. */
  refused?: RefusedSave;
}): StylingModel {
  const { wardrobe, aim, opened, styled, windows, refused } = input;
  return {
    state: {
      destination: aim.destination,
      capsuleId: wardrobe.capsule?.id,
      picks: wardrobe.picks,
      withId: opened.with?.id,
      outfitId: opened.saved?.id,
      ownerId: wardrobe.viewOwner,
      returnTo: input.returnTo,
    },
    destination: aim.destination,
    rows: modelRows(input),
    roles: rolesOf(windows),
    seed: styled.seed,
    notice: styled.missed ? 'no-idea' : undefined,
    capsule: wardrobe.capsule,
    picksOffered: wardrobe.picksOffered,
    capsules: input.capsules,
    outfit: opened.saved,
    trip: aim.trip,
    shared:
      input.owner === undefined
        ? undefined
        : { ownerId: wardrobe.ownerId, name: input.owner },
    refusal: refused && {
      message: refused.error.message,
      incomplete: refused.error instanceof OutfitIncomplete,
      draft: refused.draft,
      toBuy:
        refused.error instanceof OutfitIncomplete
          ? [...refused.error.pieces]
          : refused.error.gone.flatMap((g) =>
              g.garment?.status === 'wishlist'
                ? [{ id: g.id, name: g.garment.name }]
                : [],
            ),
    },
  };
}

/** The page's rows: a refused Save's as posted, else the opening ones. */
function modelRows(input: {
  opened: Opened;
  styled: StyledOpening;
  windows: RoleWindow[];
  refused?: RefusedSave;
}): StylingRow[] {
  const { opened, windows, refused } = input;
  if (refused) {
    const states = withEveryRole(refused.states, windows);
    return stylingRows(states, windows, refused.held);
  }
  const states = openingStates(windows, {
    saved: opened.saved?.garments,
    with: opened.with,
    idea: input.styled.idea?.garments,
  });
  return stylingRows(states, windows, opened.saved?.garments ?? []);
}

/**
 * A Save refused for its garments (OutfitGarmentsGone), or for planning an
 * outfit with pieces not bought yet (OutfitIncomplete, #335), as the page
 * shows it again.
 */
interface RefusedSave {
  error: OutfitGarmentsGone | OutfitIncomplete;
  /** The posted rows, those holding a gone garment back to "No garment". */
  states: RowState[];
  /** The posted garments the requester still owns (an archived one an edit keeps). */
  held: RoledGarment[];
  /** The sheet as it was posted. */
  draft: SaveDraft;
}

/** A garment in its role's row, as the strips' windows reach it. */
function chosen(garment: { id: number; role: GarmentRole }): Chosen {
  return { role: garment.role, garmentId: garment.id };
}

/** The rows' garments, each in its row's role (roleWindowsSql). */
function chosenOf(states: readonly RowState[]): Chosen[] {
  return states.flatMap(({ role, garmentId }) =>
    garmentId === null ? [] : [{ role, garmentId }],
  );
}

/** The garments the rows hold. */
function heldIdsOf(states: readonly RowState[]): number[] {
  return states.flatMap((state) => state.garmentId ?? []);
}

/**
 * The posted rows, checked against `held` (the wardrobe's owned garments
 * among theirs): a garment that is not one of its owned garments, or not
 * of its row's role (recategorised meanwhile), leaves the row at "No
 * garment", unlocked. An archived garment an edited outfit still holds
 * stays (a detached row).
 */
function checkedStates(
  posted: readonly RowState[],
  held: readonly RoledGarment[],
): RowState[] {
  return posted.map((state) => {
    if (state.garmentId === null) return state;
    const garment = held.find((g) => g.id === state.garmentId);
    // The lock was on that garment: gone, the row is free again.
    return garment?.role === state.role
      ? state
      : { ...state, garmentId: null, locked: false };
  });
}

/** The capsule a request named, as the reads found it: a 404 outside the wardrobe. */
function checkedCapsule(
  found: CapsuleRef | null | undefined,
): CapsuleRef | undefined {
  if (found === null) throw capsuleNotFound();
  return found;
}

/** The outfit a request named (`asked`), as the reads found it: a 404 unless the requester's. */
function checkedOutfit(
  asked: number | undefined,
  found: SavedOutfit | undefined,
): SavedOutfit | undefined {
  if (asked !== undefined && !found) throw outfitNotFound();
  return found;
}

/** A settled promise's value; its refusal, thrown. */
function valueOf<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

/** The debug line's account of what a page or a shuffle was over. */
function describeScope(wardrobe: Wardrobe, opened: Opened = {}): string {
  return [
    wardrobe.viewOwner === undefined
      ? 'own wardrobe'
      : `wardrobe ${wardrobe.ownerId} (shared)`,
    wardrobe.capsule && `capsule ${wardrobe.capsule.id}`,
    wardrobe.picks && 'picks',
    opened.saved && `outfit ${opened.saved.id}`,
    opened.with && `with garment ${opened.with.id}`,
  ]
    .filter(Boolean)
    .join(', ');
}

/** The roles the wardrobe has garments of, top to toe: "Add row"'s choices. */
function rolesOf(windows: readonly RoleWindow[]): GarmentRole[] {
  return topToToe(windows).map((w) => w.role);
}

interface Plan {
  day: IsoDate;
  occasion: Occasion;
}

/** The sheet's "Add to calendar" (no destination): a day, all day without an occasion. */
function scheduled(body: {
  scheduleDate?: IsoDate;
  scheduleOccasion?: Occasion;
}): Plan | undefined {
  return body.scheduleDate
    ? {
        day: body.scheduleDate,
        occasion: body.scheduleOccasion ?? DEFAULT_OCCASION,
      }
    : undefined;
}

export const stylingRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger, weather },
  done,
) => {
  const authorize = wardrobeGuard(db, 'wardrobe');

  /**
   * The wardrobe a request addresses (its own, or one shared with the
   * requester, 404 otherwise), with the capsule it names: the reads check
   * that (reads.ts; a 404 outside it, checkedCapsule).
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

  /**
   * Where Shuffle's ideas are aimed: the page's `?for=` (its day's weather
   * and occasion, a trip's destination) on one's own wardrobe; over a
   * shared one, nowhere (browseIdea reads none of the owner's days).
   */
  async function aimOf(
    actor: Actor,
    shared: boolean,
    query: { for?: string; occasion?: string; replace?: string },
    today: IsoDate,
  ): Promise<IdeasAim> {
    const none: OutfitDestination = { kind: 'none' };
    return aimIdeas(db, actor, shared ? none : parseDestination(query), today);
  }

  /**
   * The page without "Style this": the fresh stack, or a saved outfit's
   * rows (`?outfit=`, the requester's own, never opened over a shared
   * wardrobe), in one statement beside the aim (a trip's lookup): the
   * windows reach the outfit's garments through its id. The capsule is
   * refused before the trip or the outfit, as it always was.
   */
  async function plainOpening(
    actor: Actor,
    scope: Scope,
    query: Static<typeof PageQuery>,
    today: IsoDate,
    outfitId: number | undefined,
  ): Promise<Opening> {
    const [aimed, read] = await Promise.allSettled([
      aimOf(actor, scope.shared, query, today),
      stripsReads(db, scope, {
        checkCapsule: true,
        outfitId,
        chosen: [],
        chosenOutfit: outfitId,
        menu: true,
      }),
    ]);
    const reads = valueOf(read);
    const capsule = checkedCapsule(reads.capsule);
    const aim = valueOf(aimed);
    const saved = checkedOutfit(query.outfit, reads.outfit);
    return {
      wardrobe: wardrobeOf(scope, capsule, reads),
      aim,
      opened: { saved },
      styled: {},
      reads,
    };
  }

  /**
   * "Style this" (`?with=`, a closet garment of the wardrobe: else a 404)
   * opens on the day's first idea around the garment, locked; the page
   * then carries the next seed for Shuffle. Nothing else reads the day:
   * the bare page's fresh stack stays byte-stable (page-cache.ts). The
   * garment, the outfit and the capsule are checked in the idea's
   * statement (ideaReads); then the windows reach the idea (stripsReads).
   */
  async function styledOpening(
    actor: Actor,
    scope: Scope,
    query: Static<typeof PageQuery>,
    today: IsoDate,
    outfitId: number | undefined,
    withId: number,
  ): Promise<Opening> {
    const aim = await aimOf(actor, scope.shared, query, today);
    const seed = dailySeed(today);
    const read = await ideaReads({ db, weather }, scope, {
      checkCapsule: true,
      outfitId,
      lockIds: [withId],
      aim,
      today,
      seed,
      now: new Date(),
    });
    const capsule = checkedCapsule(read.capsule);
    const saved = checkedOutfit(query.outfit, read.outfit);
    const [garment] = read.lockable;
    if (!garment) throw garmentNotFound();
    const idea = await read.draw([garment]);
    const opened: Opened = { saved, with: garment };
    const reads = await stripsReads(db, scope, {
      chosen: [
        ...(saved?.garments ?? []),
        garment,
        ...(idea?.garments ?? []),
      ].map(chosen),
      menu: true,
    });
    return {
      wardrobe: wardrobeOf(scope, capsule, reads),
      aim,
      opened,
      styled: { idea, seed: shuffledSeed(seed), missed: !idea },
      reads,
    };
  }

  app.get(
    STYLING_PATH,
    { schema: { querystring: PageQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { query } = request;
      const today = todayIn(config.timeZone, new Date());
      const scope = await scopeOf(request);
      // A saved outfit is the requester's: over a shared wardrobe, a 404.
      const outfitId = isOther(query.ownerId, userId)
        ? undefined
        : query.outfit;
      const { wardrobe, aim, opened, styled, reads } =
        query.with === undefined
          ? await plainOpening(actorOf(request), scope, query, today, outfitId)
          : await styledOpening(
              actorOf(request),
              scope,
              query,
              today,
              outfitId,
              query.with,
            );
      const model = pageModel({
        wardrobe,
        aim,
        opened,
        styled,
        windows: reads.windows,
        capsules: reads.capsules,
        owner: reads.owner,
        returnTo: returnToOf(query.returnTo),
      });
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

  /**
   * The state a fragment's links carry on (the sentinel's, the Include
   * picks switch's pushed address), from a posted query.
   */
  function postedState(query: RowsInput, wardrobe: Wardrobe): StylingState {
    const own = wardrobe.viewOwner === undefined;
    return {
      destination: parseDestination(query),
      capsuleId: wardrobe.capsule?.id,
      picks: wardrobe.picks,
      withId: query.with,
      outfitId: own ? query.outfit : undefined,
      ownerId: wardrobe.viewOwner,
      returnTo: returnToOf(query.returnTo),
    };
  }

  // Shuffle: the generator fills the unlocked rows; a GET, as it reads. The
  // posted rows are checked in the idea's statement (ideaReads), then the
  // windows reach the idea (stripsReads).
  app.get(
    STYLING_SHUFFLE_PATH,
    { schema: { querystring: RowsQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { query } = request;
      const started = performance.now();
      const today = todayIn(config.timeZone, new Date());
      const scope = await scopeOf(request);
      const posted = postedStates(query);
      const aim = await aimOf(actorOf(request), scope.shared, query, today);
      const seed = parseSeed(query.seed) ?? dailySeed(today);
      const read = await ideaReads({ db, weather }, scope, {
        checkCapsule: true,
        heldIds: heldIdsOf(posted),
        lockIds: heldIdsOf(posted.filter((state) => state.locked)),
        aim,
        today,
        seed,
        now: new Date(),
      });
      const capsule = checkedCapsule(read.capsule);
      const states = checkedStates(posted, read.held);
      const lockedIds = states.flatMap((s) =>
        s.locked && s.garmentId !== null ? [s.garmentId] : [],
      );
      const idea = await read.draw(
        read.lockable.filter((g) => lockedIds.includes(g.id)),
      );
      // The ideas draw from the closet alone: a pick is never drawn, and a
      // row the rows may carry it in (rowGarmentsSql) keeps it while locked.
      const strips = await stripsReads(db, scope, {
        chosen: [...chosenOf(states), ...(idea?.garments ?? []).map(chosen)],
      });
      const { windows } = strips;
      const wardrobe = wardrobeOf(scope, capsule, strips);
      const rows = withEveryRole(states, windows);
      logger.debug(
        `Styling shuffle for user ${userId} over ${describeScope(wardrobe)}: ${lockedIds.length} locked, seed ${seed}, ${idea ? `idea of garments ${ids(idea.garments).join(', ')}` : 'no idea fits'}${idea?.brokenRules.length ? `, the locks breaking ${idea.brokenRules.length} rule(s)` : ''} in ${Math.round(performance.now() - started)} ms`,
      );
      return renderRows(reply, {
        states: idea ? shuffledStates(rows, idea.garments) : rows,
        windows,
        held: read.held,
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

  // "Add row": the rows again, one more (empty) of the role asked for. One
  // statement: the windows reach each posted garment in its row's role,
  // which is what checkedStates keeps.
  app.get(
    STYLING_ROW_PATH,
    { schema: { querystring: RowsQuery } },
    async (request, reply) => {
      const { query } = request;
      const scope = await scopeOf(request);
      const posted = postedStates(query);
      const reads = await stripsReads(db, scope, {
        checkCapsule: true,
        heldIds: heldIdsOf(posted),
        chosen: chosenOf(posted),
        capsules: true,
      });
      const wardrobe = wardrobeOf(scope, checkedCapsule(reads.capsule), reads);
      const states = checkedStates(posted, reads.held);
      if (query.add !== undefined && states.length < MAX_ROWS) {
        states.push({ role: query.add, garmentId: null, locked: false });
      }
      return renderRows(reply, {
        states: topToToe(states),
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
  // weather (assessOutfit, the gallery's words), for the page's `?for=` as
  // Shuffle aims it (aimIdeas: today all day without one, a trip's day and
  // destination). Only with WEATHER_ENABLED, like /weather/*: no route
  // without it. Nothing over a shared wardrobe (browseIdea reads none of
  // the owner's weather), without a garment, or without a forecast for the
  // day. The rows are checked as Shuffle's are (a 400 when they do not line
  // up; a garment the rows may not carry is left out); the capsule is not
  // read, as nothing here depends on it. One statement after the session
  // (fitReads), a trip's lookup before it; it writes nothing.
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
        const today = todayIn(config.timeZone, now);
        const aim = await aimOf(actorOf(request), false, query, today);
        const read = await fitReads({ db, weather }, scope, {
          heldIds,
          aim,
          today,
          now,
        });
        const fit =
          read.weather && read.garments.length > 0
            ? {
                problems: assessOutfit(read.weather.needs, read.garments)
                  .problems,
                typical: read.weather.typical,
              }
            : undefined;
        logger.debug(
          `Styling fit for user ${userId}: ${read.garments.length} garment(s) for ${aim.planning.day} (${aim.planning.occasion}), ${fit ? fit.problems.join(', ') || 'fits' : 'no weather'}`,
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

  // Save (the sheet's native post). A new outfit goes where the page is
  // going, through the gallery's pick (pickTo: planned, added to a trip,
  // or in an entry's place, once however often it is tapped); a saved one
  // (`outfit`) is updated through the outfit writer, its slots replaced.
  // Refused for a garment it cannot hold: the page again (refusedPage).
  app.post(
    STYLING_PATH,
    { schema: { body: SaveBody } },
    async (request, reply) => {
      const { body } = request;
      try {
        return await save(reply, actorOf(request), body);
      } catch (error) {
        const states = savedStates(body);
        const refused =
          error instanceof OutfitGarmentsGone ||
          error instanceof OutfitIncomplete;
        if (!refused || !states) throw error;
        return refusedPage(request, reply, body, { error, states });
      }
    },
  );

  async function save(
    reply: FastifyReply,
    actor: Actor,
    body: Static<typeof SaveBody>,
  ) {
    const garmentIds = chosenIds(body.garmentId);
    if (garmentIds.length === 0) {
      throw new HttpError(400, 'Choose at least one garment to save');
    }
    const name = body.name?.trim() || undefined;
    const destination = postedDestination(body);
    const schedule = scheduled(body);
    if (body.outfit !== undefined) {
      return saveEdit(reply, actor, body.outfit, {
        garmentIds,
        name,
        destination,
        schedule,
        returnTo: body.returnTo,
      });
    }
    if (body.picks === '1') {
      if (destination.kind !== 'none') {
        throw new HttpError(
          400,
          'Include picks saves an outfit, never one for a day or a trip',
        );
      }
      return saveWithPicks(reply, actor, { garmentIds, name, schedule });
    }
    const planned: OutfitDestination =
      destination.kind === 'none' && schedule
        ? { kind: 'day', ...schedule }
        : destination;
    return pickTo({ db, logger }, reply, actor, planned, garmentIds, {
      source: 'styling',
      name,
    });
  }

  /**
   * A refused Save's answer: Styling as it was posted (its destination,
   * capsule, outfit and sheet), the rows holding a gone garment back to
   * "No garment", and the refusal's words above them, with its status.
   * Always the requester's own wardrobe: Save takes nothing else, so a
   * garment of another's is cleared like a deleted one and never shown.
   */
  async function refusedPage(
    request: FastifyRequest,
    reply: FastifyReply,
    body: Static<typeof SaveBody>,
    refused: Pick<RefusedSave, 'error' | 'states'>,
  ) {
    const userId = sessionUserId(request);
    const { error } = refused;
    const reason =
      error instanceof OutfitIncomplete
        ? `outfit ${error.outfitId} not planned, ${error.pieces.length} piece(s) to buy`
        : `garments ${describeGone(error.gone)}`;
    logger.info(
      `Styling save by user ${userId} refused (${error.statusCode}): ${reason}${body.outfit === undefined ? '' : ` for outfit ${body.outfit}`}; the page again`,
    );
    const today = todayIn(config.timeZone, new Date());
    // An incomplete outfit's refusal keeps every row: nothing in them is gone.
    const gone = new Set(
      error instanceof OutfitGarmentsGone ? error.gone.map((g) => g.id) : [],
    );
    const cleared = refused.states.map((state) =>
      state.garmentId !== null && gone.has(state.garmentId)
        ? { ...state, garmentId: null, locked: false }
        : state,
    );
    // One statement beside the aim, as the page without "Style this" reads
    // (plainOpening); the windows reach the rows, not the outfit's garments.
    const scope: Scope = {
      userId,
      ownerId: userId,
      shared: false,
      viewOwner: undefined,
      capsuleId: body.capsule,
      picksOffered: postedDestination(body).kind === 'none',
      picks: body.picks === '1' && postedDestination(body).kind === 'none',
      editingOutfitId: body.outfit,
    };
    const [aimed, read] = await Promise.allSettled([
      aimIdeas(db, actorOf(request), postedDestination(body), today),
      stripsReads(db, scope, {
        checkCapsule: true,
        outfitId: body.outfit,
        heldIds: heldIdsOf(cleared),
        chosen: chosenOf(cleared),
        menu: true,
      }),
    ]);
    const reads = valueOf(read);
    const capsule = checkedCapsule(reads.capsule);
    const aim = valueOf(aimed);
    const saved = checkedOutfit(body.outfit, reads.outfit);
    const model = pageModel({
      wardrobe: wardrobeOf(scope, capsule, reads),
      aim,
      opened: { saved },
      styled: {},
      windows: reads.windows,
      capsules: reads.capsules,
      owner: undefined,
      returnTo: returnToOf(body.returnTo),
      refused: {
        error: refused.error,
        states: checkedStates(cleared, reads.held),
        held: reads.held,
        draft: {
          name: body.name,
          scheduleDate: body.scheduleDate || undefined,
          scheduleOccasion: body.scheduleOccasion,
        },
      },
    });
    return renderPage(
      reply,
      <StylingPage ctx={viewContext(reply)} model={model} />,
      { status: refused.error.statusCode },
    );
  }

  /**
   * A saved outfit changed in Styling: its slots replaced by the rows'
   * garments top to toe, its name (blank: named for its garments), and
   * planned on a day when asked, in one transaction (updateOutfit, which
   * also makes the week planner's entries of it the person's and prunes
   * the packed marks of garments it no longer holds). The garments must
   * all be the requester's own (else OutfitGarmentsGone, a 404, and nothing
   * is written); what the outfit may hold of them is updateOutfit's to
   * judge (insertSlots, slotMayNameSql: an archived one it holds stays, a
   * piece to buy while nothing holds the outfit, #335), and it
   * refuses whole, named, as the page answers. It changes in place, so a
   * trip or an entry to replace is a 400.
   */
  async function saveEdit(
    reply: FastifyReply,
    actor: Actor,
    outfitId: number,
    input: {
      garmentIds: number[];
      name: string | undefined;
      destination: OutfitDestination;
      schedule: Plan | undefined;
      returnTo: string | undefined;
    },
  ) {
    const { userId } = actor;
    const { destination } = input;
    if (
      destination.kind === 'trip' ||
      (destination.kind === 'day' && destination.replace !== undefined)
    ) {
      throw new HttpError(
        400,
        'A saved outfit changes in place: plan it on a day only',
      );
    }
    const plan =
      destination.kind === 'day'
        ? { day: destination.day, occasion: destination.occasion }
        : input.schedule;
    const garments = topToToe(
      await savedGarments(db, userId, input.garmentIds),
    );
    if (garments.length !== input.garmentIds.length) {
      throw await garmentsGoneError(db, userId, input.garmentIds, 'wardrobe');
    }
    await editOutfit({ db, logger }, actor, outfitId, {
      name: input.name ?? ideaName(garments),
      slots: garments.map((g) => ({ category: g.category, garmentId: g.id })),
      plan,
    });
    return reply.redirect(
      safeReturnTo(input.returnTo, `/outfits/${outfitId}`),
      303,
    );
  }

  /**
   * A new outfit's Save with Include picks on (#335): a slot write through
   * the outfit writer (createOutfit), not a pick, so a pick in the rows is
   * held and the outfit is incomplete (src/web/outfits/references.ts);
   * once however often it is posted (createOutfit reuses an outfit of the
   * same garments). Its garments are read for their categories alone
   * (savedGarments, in posted order); what the outfit may hold is judged
   * by the writer under the owner lock (insertSlots: slotMayNameSql), so an
   * archived garment or a pick set aside meanwhile refuses it, nothing
   * written. Planned on the sheet's day only when complete: an incomplete
   * one is refused whole (OutfitIncomplete), the page again with its pieces.
   */
  async function saveWithPicks(
    reply: FastifyReply,
    actor: Actor,
    input: {
      garmentIds: number[];
      name: string | undefined;
      schedule: Plan | undefined;
    },
  ) {
    const { userId } = actor;
    const garments = topToToe(
      await savedGarments(db, userId, input.garmentIds),
    );
    if (garments.length !== input.garmentIds.length) {
      throw await garmentsGoneError(db, userId, input.garmentIds, 'wardrobe');
    }
    const saved = await saveOutfit({ db, logger }, actor, {
      name: input.name ?? ideaName(garments),
      slots: garments.map((g) => ({ category: g.category, garmentId: g.id })),
      plan: input.schedule,
      origin: 'person',
      madeBy: BY_PERSON,
    });
    const flag = alreadySavedParam(saved);
    return reply.redirect(
      input.schedule
        ? `/calendar?week=${input.schedule.day}${flag && `&${flag}`}`
        : `/outfits/${saved.id}${flag && `?${flag}`}`,
      303,
    );
  }

  done();
};
