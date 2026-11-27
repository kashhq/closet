import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { CapsuleRef } from '../capsules/queries';
import { readGridCursor } from './grid-cursor';
import {
  capsuleNotFound,
  setCapsuleMembers,
} from '../capsules/capsule-actions';
import {
  findType,
  FORMALITIES,
  GARMENT_COLORS,
  MATERIALS,
  WARMTHS,
} from '../../wardrobe/properties';
import { CARE_WASH } from '../../wardrobe/care';
import { sessionUserId } from '../auth/require-session';
import type { WebOptions } from '../plugin';
import { todayIn } from '../../calendar-date';
import { postedInstant } from '../offline-writes';
import { renderFragment, renderPage, wantsFragment } from '../render';
import { actorOf, type WardrobeAccess } from '../sharing/access';
import { viewContext } from '../view-context';
import { normalizeCategory, normalizeSize } from './garment';
import {
  garmentAddress,
  garmentGuard,
  taggedGarmentIn,
} from './garment-access';
import { bulkSetGarments, tagGarment } from './garment-actions';
import { washGarments } from '../wears/wear-actions';
import { type GridFilters, gridIds, gridPage, nextToTag } from './queries';
import { type GridContextPart, gridContext } from './grid-context';
import {
  type GarmentScope,
  setGarmentsStatus,
  type StatusOutcome,
} from './status';
import {
  TAG_CARD_ID,
  TagCard,
  type TagCardModel,
  TagPage,
  TagSaved,
} from './tag-page';
import { idListValue, TAG_PATH, wardrobeUrl, readIdList } from './urls';
import {
  type BulkOutcome,
  GarmentTiles,
  type GridSearch,
  type Selection,
  searchParams,
  WardrobeFragment,
  WardrobePage,
} from './wardrobe-page';
import {
  BulkBody,
  CapsuleBulkBody,
  GridQuery,
  SELECTED_MAX_LENGTH,
  SelectionBody,
  readBulkChange,
  TagBody,
  TagQuery,
  TilesQuery,
} from './grid-schemas';
import { GarmentParams, OwnerQuery, pick } from '../schemas';

/** The filters as the page echoes them. */
function gridSearch(query: GridQuery, isOwner: boolean): GridSearch {
  const category = query.category ? normalizeCategory(query.category) : '';
  return {
    keyword: query.keyword?.trim() ?? '',
    category,
    color: query.color ?? '',
    size: (query.size && normalizeSize(query.size)) || '',
    ...propertySearch(query, category),
    archived: query.archived === 'true' ? 'true' : '',
    capsule: query.capsule ? String(query.capsule) : '',
    ...careSearch(query, isOwner),
  };
}

/**
 * The care filters. "Needs a wash" reads the owner's wears, so it is
 * dropped on a shared wardrobe (`isOwner` false), like a type without its
 * category: the grid shows unfiltered, and reveals nothing.
 */
function careSearch(
  query: GridQuery,
  isOwner: boolean,
): Pick<GridSearch, 'needsWash' | 'attention'> {
  return {
    needsWash: isOwner && query.needsWash === 'true' ? 'true' : '',
    attention: query.attention === 'true' ? 'true' : '',
  };
}

/** The property filters; a type only with its own category. */
function propertySearch(
  query: GridQuery,
  category: string,
): Pick<GridSearch, 'type' | 'warmth' | 'formality' | 'material' | 'wash'> {
  return {
    type: findType(category, query.type)?.value ?? '',
    warmth: query.warmth ?? '',
    formality: query.formality ?? '',
    material: query.material ?? '',
    wash: query.wash ?? '',
  };
}

function gridFilters(search: GridSearch): GridFilters {
  return {
    keyword: search.keyword || undefined,
    category: search.category || undefined,
    color: pick(GARMENT_COLORS, search.color) ?? undefined,
    size: search.size || undefined,
    ...propertyFilters(search),
    scope: scopeOf(search),
    capsule: search.capsule ? Number(search.capsule) : undefined,
    needsWash: search.needsWash === 'true',
    attention: search.attention === 'true',
  };
}

/** The property filters as the query layer takes them (propertySearch's). */
function propertyFilters(
  search: GridSearch,
): Pick<GridFilters, 'type' | 'warmth' | 'formality' | 'material' | 'wash'> {
  return {
    type: search.type || undefined,
    warmth: pick(WARMTHS, search.warmth) ?? undefined,
    formality: pick(FORMALITIES, search.formality) ?? undefined,
    material: pick(MATERIALS, search.material) ?? undefined,
    wash: pick(CARE_WASH, search.wash) ?? undefined,
  };
}

/** The grid's garments: the closet, or with "Include archived" the archive too. */
function scopeOf(search: GridSearch): GarmentScope {
  return search.archived === 'true' ? 'owned' : 'closet';
}

/** What a select-mode verb's redirect reports, for its toast. */
function bulkOutcome(query: GridQuery): BulkOutcome | undefined {
  if (query.bulkUpdated !== undefined) {
    return {
      verb: 'set',
      count: query.bulkUpdated,
      skipped: query.bulkSkipped ?? 0,
    };
  }
  if (query.bulkArchived !== undefined) {
    return { verb: 'archive', count: query.bulkArchived };
  }
  if (query.bulkWashed !== undefined) {
    return {
      verb: 'wash',
      count: query.bulkWashed,
      skipped: query.bulkSkipped ?? 0,
      wishlist: query.bulkWishlist ?? 0,
      unseen: query.bulkUnseen ?? 0,
    };
  }
  if (query.bulkAdded !== undefined) {
    return { verb: 'capsule', count: query.bulkAdded };
  }
  return undefined;
}

/** The selection a verb's redirect checked again (selectionParams), as the page reads it. */
function readSelection(query: GridQuery): Selection {
  return {
    ids: new Set(readIdList(query.selected)),
    all: query.all === '1',
  };
}

/**
 * The selection as a verb's redirect carries it back: always the ids
 * acted on, never `all=1` (a kept `all` re-runs the filters, so a "Set…"
 * that changes the filtered property would turn "Select all N" into a
 * different set for the next verb). While they fit in a URL
 * (SELECTED_MAX_LENGTH; past it select mode comes back with nothing
 * checked rather than a 400).
 */
function selectionParams(selection: {
  ids: readonly number[];
}): Record<string, string | undefined> {
  const selected = idListValue(selection.ids);
  return { selected: selected.length <= SELECTED_MAX_LENGTH ? selected : '' };
}

/** A verb's log line says when the selection was "Select all" (the filters', not ids). */
function allNote(selection: { all: boolean }): string {
  return selection.all ? ' (all of the filters)' : '';
}

/** The capsule `id` names among the wardrobe's own, or a 404 like an unknown id. */
function listedCapsule(capsules: CapsuleRef[], id: number): CapsuleRef {
  const found = capsules.find((capsule) => capsule.id === id);
  if (!found) throw capsuleNotFound();
  return found;
}

/**
 * What GET /wardrobe's answer renders around its tiles (GridContext):
 * browsing, all of it the requester may see, the app bar's switcher only
 * on a full page (a fragment swaps #wardrobe-body and the ⋯ menu). The
 * picker reads only the capsules (to refuse another wardrobe's `?pick=` and
 * to name it); select mode the count ("Select all N") and the capsules
 * (its "Add to capsule", and a foreign `?capsule=`).
 */
function gridContextParts(answer: {
  access: WardrobeAccess;
  selecting: boolean;
  fragment: boolean;
  pick: number | undefined;
}): Set<GridContextPart> {
  const { access, selecting, fragment, pick } = answer;
  if (pick !== undefined) return new Set(['capsules']);
  // Select mode's "Select all N" and "Add to capsule" (#677).
  if (selecting) return new Set(['count', 'capsules']);
  const parts: GridContextPart[] = ['count', 'options', 'capsules'];
  // Tagging and drafts are for someone who can write; wears are the owner's.
  if (access.canManage) parts.push('toTag', 'drafts');
  if (access.isOwner) parts.push('toWash');
  if (!fragment) parts.push('sharedWardrobes');
  return new Set(parts);
}

/**
 * The grid and the modes that work on it: GET /wardrobe (with its fragment),
 * its "load more" tiles, select mode's verbs and tagging mode. Every
 * route takes `?ownerId=` for a shared wardrobe (garmentGuard).
 */
export const gridRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger, config } = options;
  const authorize = garmentGuard(db);

  /** The tagging card for the garment after `before` (the first without). */
  async function tagCardModel(
    ownerId: number,
    viewOwner: number | undefined,
    before: number | undefined,
  ): Promise<TagCardModel> {
    return { ...(await nextToTag(db, ownerId, before)), viewOwner };
  }

  // Filtering and searching are navigation state: malformed values fall
  // back or are dropped, except a colour outside the built-in set (400,
  // GridQuery) and a capsule that is not the wardrobe's (404). An htmx
  // fragment request (the scope row, the facets) gets #wardrobe-body, and
  // the facets and the ⋯ menu out of band; the first page only, always.
  // `?pick=` (owner and MANAGE) is the capsule picker: select mode with the
  // capsule's members checked.
  app.get(
    '/wardrobe',
    { schema: { querystring: GridQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { access, viewOwner } = await authorize(request, 'view');
      const search = gridSearch(request.query, access.isOwner);
      const filters = gridFilters(search);
      const pick = access.canManage ? request.query.pick : undefined;
      // Only someone who may write can select for a bulk edit or pick.
      const selecting =
        access.canManage &&
        (request.query.select === '1' || pick !== undefined);
      const fragment = wantsFragment(request, reply);
      // Two statements (and the session's): the page, and everything
      // around it that this answer renders (gridContextParts).
      const [page, context] = await Promise.all([
        gridPage(db, access, filters, {
          ownerView: access.isOwner,
          pick,
        }),
        gridContext(
          db,
          { userId, ownerId: access.ownerId, role: access.role, filters },
          gridContextParts({ access, selecting, fragment, pick }),
        ),
      ]);
      const { capsules } = context;
      if (filters.capsule) listedCapsule(capsules, filters.capsule);
      const picking =
        pick === undefined ? undefined : listedCapsule(capsules, pick);
      const model = {
        ...context,
        search,
        page,
        viewOwner,
        canEdit: access.canManage,
        ownerView: access.isOwner,
        selecting,
        picking: picking && { capsuleId: picking.id, name: picking.name },
        bulkOutcome: bulkOutcome(request.query),
        // A batch's end (#200): its garments start checked for "Set…".
        batchSaved: new Set(readIdList(request.query.checked)),
        selection: readSelection(request.query),
      };
      if (fragment) {
        return renderFragment(
          reply,
          <WardrobeFragment ctx={viewContext(reply)} model={model} />,
        );
      }
      return renderPage(
        reply,
        <WardrobePage ctx={viewContext(reply)} model={model} />,
      );
    },
  );

  // The grid's "load more" sentinel (hx-trigger="revealed"): the page after
  // `before`, with the same filters, and the next sentinel. Always a fragment.
  app.get(
    '/wardrobe/tiles',
    { schema: { querystring: TilesQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await authorize(request, 'view');
      // The capsule filter needs no lookup here: it matches nothing outside
      // the capsule's own wardrobe (inCapsule), and the page that started
      // the scroll already refused a foreign one. Neither does the picker:
      // a capsule of another wardrobe has no members here.
      const search = gridSearch(request.query, access.isOwner);
      const pick = access.canManage ? request.query.pick : undefined;
      const page = await gridPage(db, access, gridFilters(search), {
        before: readGridCursor(request.query.before),
        ownerView: access.isOwner,
        pick,
      });
      const picking = pick === undefined ? undefined : { capsuleId: pick };
      return renderFragment(
        reply,
        <GarmentTiles
          page={page}
          search={search}
          viewOwner={viewOwner}
          selecting={
            access.canManage &&
            (request.query.select === '1' || pick !== undefined)
          }
          picking={picking}
          selection={readSelection(request.query)}
        />,
      );
    },
  );

  /**
   * The garments a select-mode verb acts on (#677): the checked `ids`, or
   * with `all` every garment of the filters in the action's query, through
   * the grid's own gridSearch and gridWhere (gridIds), so "Select all N" is
   * the N the page showed, never only its loaded tiles.
   */
  async function selected(
    access: WardrobeAccess,
    request: { query: GridQuery; body: SelectionBody },
  ): Promise<{ ids: number[]; all: boolean; search: GridSearch }> {
    const search = gridSearch(request.query, access.isOwner);
    const all = request.body.all === '1';
    const ids = all
      ? await gridIds(db, access, gridFilters(search))
      : (request.body.ids ?? []);
    return { ids, all, search };
  }

  /** Back to select mode as it was: the same filters, the selection checked, the verb's toast. */
  function backToSelection(
    viewOwner: number | undefined,
    search: GridSearch,
    kept: { ids: readonly number[] } | undefined,
    flags: Record<string, number>,
  ): string {
    return wardrobeUrl(viewOwner, {
      ...searchParams(search),
      select: '1',
      ...(kept && selectionParams(kept)),
      ...flags,
    });
  }

  // Select mode's verbs (select-and-tag.md): native posts (PostForm; htmx
  // drops a 4xx, and the answer is another page anyway), each with the
  // filters in its action's query, answered 303 back to select mode with
  // the selection still checked, so a second verb needs no reselecting.
  // Each calls its writer once, and the writer takes the owner lock.

  // "Set…": one property on every selected garment its role allows
  // (bulkSetProperty), with how many were set and skipped for the toast.
  app.post(
    '/wardrobe/bulk',
    { schema: { querystring: GridQuery, body: BulkBody } },
    async (request, reply) => {
      const { access, viewOwner } = await authorize(request, 'manage');
      const selection = await selected(access, request);
      const { ids } = selection;
      const change = readBulkChange(request.body);
      const result = await bulkSetGarments(
        { db, logger },
        actorOf(request),
        access.ownerId,
        ids,
        change,
      );
      return reply.redirect(
        backToSelection(viewOwner, selection.search, selection, {
          bulkUpdated: result.updated,
          bulkSkipped: result.skipped,
        }),
        303,
      );
    },
  );

  // Archive: the owner's alone, as a garment's own Archive (a MANAGE
  // grantee is refused). setGarmentsStatus moves what the machine lets go
  // (an archived garment stays, uncounted). The archived leave the grid,
  // so select mode comes back with nothing checked: a kept `all` would
  // select what is left.
  app.post(
    '/wardrobe/bulk/archive',
    { schema: { querystring: GridQuery, body: SelectionBody } },
    async (request, reply) => {
      const { access, viewOwner } = await authorize(request, 'own');
      const selection = await selected(access, request);
      const { ids } = selection;
      const outcomes =
        ids.length > 0
          ? await setGarmentsStatus(db, ids, access.ownerId, {
              event: 'archive',
            })
          : new Map<number, StatusOutcome>();
      const archived = [...outcomes.values()].filter((move) => move.ok).length;
      logger.info(
        `Bulk archive by user ${sessionUserId(request)} in wardrobe ${access.ownerId}: ${archived} archived, ${ids.length} selected${allNote(selection)}`,
      );
      return reply.redirect(
        backToSelection(viewOwner, selection.search, undefined, {
          bulkArchived: archived,
        }),
        303,
      );
    },
  );

  // Mark washed: the owner's own record (wears and washes are never a
  // grantee's), today, as the laundry's batch (washGarments). The closet's
  // garments only: Select all on "Include archived" must not wash the archive
  // (#816; a garment's own page still may), and the toast names each skip by
  // its reason (#819): one deleted in another tab, or a hand-built post's
  // wishlist or foreign id, is not "archived". Not queued offline like the laundry's: "Select all" is
  // resolved here, so the verbs need the server (data-needs-network on the
  // bar).
  app.post(
    '/wardrobe/bulk/washed',
    { schema: { querystring: GridQuery, body: SelectionBody } },
    async (request, reply) => {
      const { access, viewOwner } = await authorize(request, 'own');
      const selection = await selected(access, request);
      const day = todayIn(config.timeZone, new Date());
      const { washed, skipped } = await washGarments(
        { db, logger },
        actorOf(request),
        selection.ids,
        { day, at: postedInstant(request, undefined, day, config.timeZone) },
        { closetOnly: true },
      );
      return reply.redirect(
        backToSelection(viewOwner, selection.search, selection, {
          bulkWashed: washed.length,
          bulkSkipped: skipped.archived,
          // Only when there are any: a hand-built post's, or a tab's stale selection.
          ...(skipped.wishlist > 0 && { bulkWishlist: skipped.wishlist }),
          ...(skipped.unseen > 0 && { bulkUnseen: skipped.unseen }),
        }),
        303,
      );
    },
  );

  // Add to capsule: the selection joins the capsule (setCapsuleMembers,
  // which refuses itself: owner or MANAGE, a capsule outside the wardrobe a
  // 404); nothing leaves it. The toast counts the garments new to it.
  app.post(
    '/wardrobe/bulk/capsule',
    { schema: { querystring: GridQuery, body: CapsuleBulkBody } },
    async (request, reply) => {
      const { access, viewOwner } = await authorize(request, 'manage');
      const selection = await selected(access, request);
      const { capsuleId } = request.body;
      const { added } = await setCapsuleMembers(
        { db, logger },
        actorOf(request),
        { id: capsuleId, ownerId: request.query.ownerId },
        { add: selection.ids, remove: [] },
      );
      return reply.redirect(
        backToSelection(viewOwner, selection.search, selection, {
          bulkAdded: added,
        }),
        303,
      );
    },
  );

  // Tagging mode (src/web/wardrobe/tag-page.tsx): the next garment still
  // needing its type, warmth or formality, after `?before=`. A fragment
  // request gets the card alone: Next was a link here before it became the
  // card's submit button, and pages the installed app cached still ask.
  app.get(
    TAG_PATH,
    { schema: { querystring: TagQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await authorize(request, 'manage');
      const model = await tagCardModel(
        access.ownerId,
        viewOwner,
        request.query.before,
      );
      if (wantsFragment(request, reply)) {
        return renderFragment(reply, <TagCard model={model} />);
      }
      return renderPage(
        reply,
        <TagPage ctx={viewContext(reply)} model={model} />,
      );
    },
  );

  // The tagging card's AutosaveForm (tag-page.tsx): a tap saves the chips
  // and answers them as saved (a new type's presets filled where nothing was
  // set; readTags) with the count left; Next (`next=1`) saves the same way
  // and answers the card after this garment instead. A post that changes
  // nothing writes nothing: Next on a card left alone only moves on.
  app.post(
    '/wardrobe/:id/tag',
    {
      schema: { params: GarmentParams, querystring: OwnerQuery, body: TagBody },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { next, ...tags } = request.body;
      // Only what differs from the stored garment: the card posts its
      // checked chips every time, Next included.
      const { access, viewOwner } = await tagGarment(
        { db, logger },
        actorOf(request),
        garmentAddress(request),
        tags,
      );
      if (next) {
        logger.info(
          `Tagging: user ${sessionUserId(request)} moved on from garment ${id}`,
        );
        // The whole card, not the chips the form targets: the next garment's.
        reply.header('HX-Retarget', `#${TAG_CARD_ID}`);
        reply.header('HX-Reswap', 'outerHTML');
        return renderFragment(
          reply,
          <TagCard model={await tagCardModel(access.ownerId, viewOwner, id)} />,
        );
      }
      const saved = await taggedGarmentIn(db, access, id);
      return renderFragment(
        reply,
        <TagSaved garment={saved.garment} left={saved.left} />,
      );
    },
  );

  done();
};
