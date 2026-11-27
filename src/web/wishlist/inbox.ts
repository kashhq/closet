import { and, eq, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db, Queryable } from '../../db/client';
import { file, garment, optionGroup, user } from '../../db/schema';
import { selectScalars } from '../../db/select-scalars';
import type { BestOutfits, OutfitCount } from '../../wardrobe/goes-with';
import type {
  DismissReason,
  OptionGroupStatus,
} from '../../wardrobe/suggestions';
import type { SignablePhotoRef } from '../files/image-url';
import { photoRefJson } from '../files/queries';
import { bestOutfitsOf, unlocksOf } from '../gallery/ideas';
import {
  type ClosetGarment,
  goesWithManyInputsSql,
  readManyGoesWithInputs,
} from '../gallery/queries';
import {
  type SharedWardrobe,
  sharedWardrobesSql,
  toSharedWardrobe,
  type WardrobeRole,
} from '../sharing/access';
import {
  type BrandSizeLookup,
  brandSizeLookup,
  brandSizesSql,
} from '../sizes/queries';
import { priceJsonPair } from '../wardrobe/private-fields';
import { onWishlist, wanted } from '../wardrobe/status';
import { type GarmentRef } from './queries';
import {
  type AgentLabel,
  agentLabelSql,
  type AgentViewer,
  OWNER_READS,
} from '../write-origin';

/**
 * The Muse inbox's reads (#333 PR B; docs/plans/2026-10-05-muse-suggestions.md,
 * section 4 D and C): the Wishlist tab as the inbox and a need's decision
 * screen. Each page is one statement after the session (selectScalars):
 * the needs with their picks, the owner's own wishlist, the switcher, the
 * brand notes and, for the owner alone, "Unlocks N"'s inputs (the picks
 * locked against one closet read, goesWithManyInputsSql). A grantee reads
 * the needs and Muse's notes (owner decision, 2026-10-05) but never the
 * owner's closet, so no unlocks and no decisions; a VIEW grantee no listed
 * price either (`private`, #680: priceJsonPair). "Still wanted" is
 * wanted() and nothing else; every decision is decide()'s (decisions.ts).
 */

/** Group cards per page of the inbox (the Ideas sentinel's paging, doc section 7). */
export const GROUPS_PAGE_SIZE = 10;

/** One of Muse's picks as a card shows it. */
export interface MusePick {
  id: number;
  name: string | null;
  brand: string | null;
  category: string;
  /** The listed price, '49.90'; null when unknown, absent without `private`. */
  price?: string | null;
  sourceUrl: string | null;
  photo: SignablePhotoRef | null;
  /** Muse's place for it among the need's options, 1 its pick; null: unranked. */
  rank: number | null;
  /** Muse's reasoning. */
  note: string | null;
  dismissedAt: string | null;
  dismissedReason: DismissReason | null;
  dismissedNote: string | null;
}

/** One need (an option group) with its picks still on the wishlist. */
export interface Need {
  id: number;
  name: string;
  /** Per piece, '300.00'; null when Muse set none. */
  budget: string | null;
  /** Muse's reasoning for the need. */
  note: string | null;
  status: OptionGroupStatus;
  resolvedGarmentId: number | null;
  dismissedReason: DismissReason | null;
  ownerNote: string | null;
  /** Muse, as the reader may see it (agentLabelSql: "Agent" to a grantee). */
  agent: AgentLabel | null;
  /** Its picks on the wishlist, wanted or set aside, Muse's rank order. */
  picks: MusePick[];
  resolver: GarmentRef | null;
}

/** An owner's own wishlist item (or a suggestion outside any need). */
interface OwnItem {
  id: number;
  name: string | null;
  brand: string | null;
  category: string;
  /** Absent without `private`. */
  price?: string | null;
  sourceUrl: string | null;
  photo: SignablePhotoRef | null;
  /** A suggestion outside any need: "From Muse" (until phase 3's singles). */
  suggested: boolean;
  /** The agent that added it, as the reader may see it (#822); a plain item's badge. */
  agent: AgentLabel | null;
  dismissedAt: string | null;
  dismissedReason: DismissReason | null;
  replaces: GarmentRef | null;
}

/**
 * A pick still open. Every pick read here is on the wishlist already
 * (needPicksSql filters by onWishlist), so wanted()'s other half, not set
 * aside, is all that is left to ask of the row.
 */
export function isOpenPick(pick: MusePick): boolean {
  return pick.dismissedAt === null;
}

/**
 * The garment table under a second name, for a raw subquery's FROM:
 * interpolated, a Drizzle alias renders as its name alone, so the FROM
 * says what it aliases (its columns, `resolverGarment.id`, render
 * qualified by the name).
 */
function aliased(name: string) {
  return {
    columns: alias(garment, name),
    from: sql`${garment} as ${sql.identifier(name)}`,
  };
}

const resolver = aliased('resolver');
const resolverGarment = resolver.columns;
const replaced = aliased('replaced');
const replacedGarment = replaced.columns;

/** A pick as `role` reads it: its price only with `private`. */
const pickJson = (role: WardrobeRole) => sql<MusePick>`json_build_object(
  'id', ${garment.id},
  'name', ${garment.name},
  'brand', ${garment.brand},
  'category', ${garment.category},
  ${priceJsonPair(role)}
  'sourceUrl', ${garment.sourceUrl},
  'photo', ${photoRefJson},
  'rank', ${garment.suggestionRank},
  'note', ${garment.suggestionNote},
  'dismissedAt', ${garment.dismissedAt},
  'dismissedReason', ${garment.dismissedReason},
  'dismissedNote', ${garment.dismissedNote}
)`;

/** A need's picks on the wishlist, Muse's rank first (unranked last), then oldest. */
const needPicksSql = (role: WardrobeRole) => sql<MusePick[]>`(
  select coalesce(
    json_agg(${pickJson(role)} order by ${garment.suggestionRank} nulls last, ${garment.id}),
    '[]'
  )
  from ${garment}
  left join ${file} on ${eq(file.id, garment.photoId)}
  where ${and(eq(garment.suggestionGroupId, optionGroup.id), onWishlist())}
)`;

/** The garment that settled a need: the chosen pick, or what the owner bought. */
const resolverSql = sql<GarmentRef | null>`(
  select json_build_object(
    'id', ${resolverGarment.id},
    'name', ${resolverGarment.name},
    'category', ${resolverGarment.category},
    'status', ${resolverGarment.status}
  )
  from ${resolver.from}
  where ${eq(resolverGarment.id, optionGroup.resolvedGarmentId)}
)`;

/** The owner's needs `which` picks, as JSON, oldest first, as `viewer` reads them with `role`. */
function needsSql(
  ownerId: number,
  which: SQL | undefined,
  viewer: AgentViewer,
  role: WardrobeRole,
): SQL<Need[]> {
  return sql<Need[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${optionGroup.id},
      'name', ${optionGroup.name},
      'budget', ${optionGroup.budget}::text,
      'note', ${optionGroup.note},
      'status', ${optionGroup.status},
      'resolvedGarmentId', ${optionGroup.resolvedGarmentId},
      'dismissedReason', ${optionGroup.dismissedReason},
      'ownerNote', ${optionGroup.ownerNote},
      'agent', ${agentLabelSql(optionGroup.suggestedByTokenId, viewer)},
      'picks', ${needPicksSql(role)},
      'resolver', ${resolverSql}
    ) order by ${optionGroup.id}), '[]')
    from ${optionGroup}
    where ${and(eq(optionGroup.ownerId, ownerId), which)}
  )`;
}

/**
 * What the inbox shows of a need: open or set aside, or chosen and not
 * yet bought (its resolver still on the wishlist: Ready to buy). A need
 * settled by a purchase has left the inbox.
 */
const inInbox = sql`(${optionGroup.status} <> 'resolved' or exists (
  select 1 from ${resolver.from}
  where ${resolverGarment.id} = ${optionGroup.resolvedGarmentId}
    and ${resolverGarment.status} = 'wishlist'
))`;

/**
 * The needs whose decision screens the offline warm keeps
 * (src/web/shell/warm-list.ts): those the inbox shows, but the ones set
 * aside, newest first.
 */
export function inboxNeedIdsSql(ownerId: number): SQL<number[]> {
  return sql<number[]>`(
    select coalesce(json_agg(${optionGroup.id} order by ${optionGroup.id} desc), '[]')
    from ${optionGroup}
    where ${and(
      eq(optionGroup.ownerId, ownerId),
      sql`${optionGroup.status} <> 'dismissed'`,
      inInbox,
    )}
  )`;
}

/**
 * The wanted picks of open needs (over `garment`; the caller scopes the
 * owner): what "Unlocks N" counts, and a round's pieces to consider
 * (rounds.ts).
 */
export const OPEN_PICKS = sql`(${wanted()} and ${garment.suggestionGroupId} in (
  select ${optionGroup.id} from ${optionGroup} where ${optionGroup.status} = 'open'
))`;

/** The wishlist garments outside any need: the owner's own items, and a lone suggestion. */
function ownItemsSql(
  ownerId: number,
  viewer: AgentViewer,
  role: WardrobeRole,
): SQL<OwnItem[]> {
  return sql<OwnItem[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${garment.id},
      'name', ${garment.name},
      'brand', ${garment.brand},
      'category', ${garment.category},
      ${priceJsonPair(role)}
      'sourceUrl', ${garment.sourceUrl},
      'photo', ${photoRefJson},
      'suggested', ${garment.suggestedAt} is not null,
      'agent', ${agentLabelSql(garment.addedByTokenId, viewer)},
      'dismissedAt', ${garment.dismissedAt},
      'dismissedReason', ${garment.dismissedReason},
      'replaces', case when ${replacedGarment.id} is null then null else json_build_object(
        'id', ${replacedGarment.id},
        'name', ${replacedGarment.name},
        'category', ${replacedGarment.category},
        'status', ${replacedGarment.status}
      ) end
    ) order by ${garment.id} desc), '[]')
    from ${garment}
    left join ${file} on ${eq(file.id, garment.photoId)}
    left join ${replaced.from} on ${eq(replacedGarment.id, garment.replacesGarmentId)}
    where ${and(
      eq(garment.ownerId, ownerId),
      onWishlist(),
      isNull(garment.suggestionGroupId),
      // A lone suggestion set aside is in "set aside"; an own item never is.
      sql`(${garment.dismissedAt} is null or ${garment.suggestedAt} is not null)`,
    )}
  )`;
}

/** What a suggestion's own page shows of it beyond the garment (suggestion-section.tsx). */
export interface SuggestionContext {
  /** Muse, as the reader may see it (agentLabelSql: "Agent" to a grantee). */
  agent: AgentLabel | null;
  note: string | null;
  dismissedReason: DismissReason | null;
  dismissedNote: string | null;
  /** Its need, with the need's picks on the wishlist; null outside one. */
  need: Need | null;
}

/**
 * A suggestion's provenance and its need as one JSON value: a column of
 * the garment page's statement (garmentContext,
 * src/web/wardrobe/garment-context.ts).
 */
export function suggestionContextSql(
  ownerId: number,
  garmentId: number,
  groupId: number | null,
  viewer: AgentViewer,
  role: WardrobeRole,
): SQL<SuggestionContext> {
  return sql<SuggestionContext>`(
    select json_build_object(
      'agent', ${agentLabelSql(garment.addedByTokenId, viewer)},
      'note', ${garment.suggestionNote},
      'dismissedReason', ${garment.dismissedReason},
      'dismissedNote', ${garment.dismissedNote},
      'need', ${groupId === null ? sql`null` : sql`(${needsSql(ownerId, eq(optionGroup.id, groupId), viewer, role)})->0`}
    )
    from ${garment}
    where ${and(eq(garment.id, garmentId), eq(garment.ownerId, ownerId))}
  )`;
}

/** An open need with something to choose, and how many outfits its options unlock. */
export interface InboxGroup {
  need: Need;
  /** Its open picks, the most unlocks first (then Muse's rank). */
  options: MusePick[];
  /** By pick id; undefined for a grantee (the owner's closet is theirs alone). */
  unlocks: Map<number, OutfitCount> | undefined;
}

/** A row of "N set aside", each with its Undo. */
export type SetAsideRow =
  | { kind: 'need'; need: Need }
  | { kind: 'pick'; pick: MusePick | OwnItem; need: Need | undefined };

export interface Inbox {
  /** Chosen, not yet bought: the need and its chosen pick. */
  readyToBuy: { need: Need; pick: MusePick }[];
  /** Open needs with options, sorted (sortGroups); the page shows one page of them. */
  groups: InboxGroup[];
  own: OwnItem[];
  /** Open needs with no open option: "Muse is still looking for". */
  stillLooking: Need[];
  setAside: SetAsideRow[];
  sharedWardrobes: SharedWardrobe[];
  /** The owner's size in each brand: their own inbox only. */
  brandSizes: BrandSizeLookup | undefined;
}

/**
 * The one count every option shares, when they all unlock the same (a
 * closet past OUTFIT_COUNT_CAP makes most "50+"): said once for the need
 * rather than on every option, where it decides nothing. Undefined when
 * they differ, or with no unlocks (a grantee).
 */
export function sharedUnlocks(
  options: readonly MusePick[],
  unlocks: ReadonlyMap<number, OutfitCount> | undefined,
): OutfitCount | undefined {
  const counts = options.map((pick) => unlocks?.get(pick.id));
  const [first] = counts;
  if (!first) return undefined;
  return counts.every(
    (count) =>
      count?.outfits === first.outfits && count.capped === first.capped,
  )
    ? first
    : undefined;
}

/** A count to sort by: "50+" above 50. */
function countValue(count: OutfitCount | undefined): number {
  if (!count) return -1;
  return count.capped ? count.outfits + 1 : count.outfits;
}

/**
 * The options most unlocks first, then Muse's rank, then oldest; the
 * needs by their best option the same way (doc section 3, "the closet
 * decides between options"). Without unlocks (a grantee) rank alone.
 */
function sortGroups(
  needs: readonly Need[],
  unlocks: Map<number, OutfitCount> | undefined,
): InboxGroup[] {
  const byPick = (a: MusePick, b: MusePick) =>
    countValue(unlocks?.get(b.id)) - countValue(unlocks?.get(a.id)) ||
    (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
    a.id - b.id;
  return needs
    .map((need) => ({
      need,
      options: need.picks.filter(isOpenPick).sort(byPick),
      unlocks,
    }))
    .filter((group) => group.options.length > 0)
    .sort(
      (a, b) => byPick(a.options[0], b.options[0]) || a.need.id - b.need.id,
    );
}

/**
 * The inbox of `ownerId`'s wardrobe as `viewerId` reads it with `role`, in one
 * statement: the needs, the own items, the switcher, and for the owner
 * the brand notes and "Unlocks N" (counted after the statement, one search
 * per open pick; logged with its time by the route). `groupsOnly`: the
 * next page's cards (GET /wardrobe/wishlist/more), which read the needs and
 * the unlocks alone. The switcher only with `switcher`: the page's, never
 * its next pages', the API's or MCP's.
 */
export async function readInbox(
  db: Db,
  {
    ownerId,
    viewerId,
    role,
    groupsOnly = false,
    switcher,
  }: {
    ownerId: number;
    viewerId: number;
    role: WardrobeRole;
    groupsOnly?: boolean;
    switcher?: boolean;
  },
): Promise<Inbox & { searchMs: number; counted: number }> {
  const isOwner = role === 'OWN';
  const viewer = { viewerId, ownsWardrobe: isOwner };
  const row = await selectScalars(db, {
    needs: needsSql(ownerId, inInbox, viewer, role),
    own: groupsOnly ? undefined : ownItemsSql(ownerId, viewer, role),
    sharedWardrobes: switcher ? sharedWardrobesSql(viewerId) : undefined,
    brandSizes: isOwner && !groupsOnly ? brandSizesSql(ownerId) : undefined,
    unlocks: isOwner ? goesWithManyInputsSql(ownerId, OPEN_PICKS) : undefined,
  });
  const started = performance.now();
  const inputs = row.unlocks && readManyGoesWithInputs(row.unlocks);
  const unlocks = inputs && unlocksOf(inputs);
  const searchMs = performance.now() - started;
  return {
    ...sectionsOf(row.needs, row.own ?? [], unlocks),
    sharedWardrobes: (row.sharedWardrobes ?? []).map(toSharedWardrobe),
    brandSizes: row.brandSizes && brandSizeLookup(row.brandSizes),
    searchMs,
    counted: inputs?.items.length ?? 0,
  };
}

/** The inbox's sections from what was read: each need and item in exactly one. */
function sectionsOf(
  needs: readonly Need[],
  own: readonly OwnItem[],
  unlocks: Map<number, OutfitCount> | undefined,
): Pick<Inbox, 'readyToBuy' | 'groups' | 'own' | 'stillLooking' | 'setAside'> {
  const open = needs.filter((need) => need.status === 'open');
  const groups = sortGroups(open, unlocks);
  const withOptions = new Set(groups.map((group) => group.need.id));
  return {
    readyToBuy: needs.flatMap((need) => {
      const pick = need.picks.find((p) => p.id === need.resolvedGarmentId);
      return need.status === 'resolved' && pick ? [{ need, pick }] : [];
    }),
    groups,
    own: own.filter((item) => item.dismissedAt === null),
    stillLooking: open.filter((need) => !withOptions.has(need.id)),
    setAside: [
      ...needs
        .filter((need) => need.status === 'dismissed')
        .map((need): SetAsideRow => ({ kind: 'need', need })),
      ...open.flatMap((need) =>
        need.picks
          .filter((pick) => !isOpenPick(pick))
          .map((pick): SetAsideRow => ({ kind: 'pick', pick, need })),
      ),
      ...own
        .filter((item) => item.dismissedAt !== null)
        .map((pick): SetAsideRow => ({ kind: 'pick', pick, need: undefined })),
    ],
  };
}

/** A need's decision screen (C): the need, and for the owner each option judged. */
export interface NeedDetail {
  need: Need;
  /** Its open picks, most unlocks first; the chosen one when resolved. */
  options: MusePick[];
  /** Picks set aside (by the owner, or because another was chosen). */
  setAside: MusePick[];
  /** By pick id: the count and the best outfits; undefined for a grantee. */
  judged: Map<number, BestOutfits<ClosetGarment>> | undefined;
  brandSizes: BrandSizeLookup | undefined;
}

/**
 * The need `groupId` of `ownerId`'s wardrobe (undefined when it is not
 * theirs), in one statement: the need with its picks and what settled it,
 * and for the owner the brand notes and each wanted pick's best outfits
 * with their closet (bestOutfitsOf).
 */
export async function readNeed(
  db: Db,
  {
    ownerId,
    groupId,
    viewerId,
    role,
  }: {
    ownerId: number;
    groupId: number;
    viewerId: number;
    role: WardrobeRole;
  },
): Promise<(NeedDetail & { searchMs: number }) | undefined> {
  const isOwner = role === 'OWN';
  const row = await selectScalars(db, {
    needs: needsSql(
      ownerId,
      eq(optionGroup.id, groupId),
      { viewerId, ownsWardrobe: isOwner },
      role,
    ),
    brandSizes: isOwner ? brandSizesSql(ownerId) : undefined,
    judged: isOwner
      ? goesWithManyInputsSql(
          ownerId,
          sql`(${eq(garment.suggestionGroupId, groupId)} and ${wanted()})`,
        )
      : undefined,
  });
  const [need] = row.needs;
  if (!need) return undefined;
  const started = performance.now();
  const judged =
    row.judged && bestOutfitsOf(readManyGoesWithInputs(row.judged));
  const searchMs = performance.now() - started;
  const value = (pick: MusePick) => countValue(judged?.get(pick.id));
  return {
    need,
    options: need.picks
      .filter(isOpenPick)
      .sort(
        (a, b) =>
          value(b) - value(a) ||
          (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
          a.id - b.id,
      ),
    setAside: need.picks.filter((pick) => !isOpenPick(pick)),
    judged,
    brandSizes: row.brandSizes && brandSizeLookup(row.brandSizes),
    searchMs,
  };
}

/** Today's card (#333): how many needs wait on the owner's choice, and whose. */
export interface NeedsToDecide {
  count: number;
  /** The newest such need's agent: Today is the owner's alone. */
  agent: AgentLabel | null;
}

/**
 * The owner's open needs with an option to choose, as a scalar subquery
 * (null for none): Today reads it beside the day in one statement
 * (todayFor's `needs`, src/web/today/today.ts) and links the inbox.
 */
export function needsToDecideSql(ownerId: number): SQL<NeedsToDecide | null> {
  return sql<NeedsToDecide | null>`(
    select case when count(*) = 0 then null else json_build_object(
      'count', count(*)::int,
      'agent', (array_agg(${agentLabelSql(optionGroup.suggestedByTokenId, OWNER_READS)} order by ${optionGroup.id} desc))[1]
    ) end
    from ${optionGroup}
    where ${and(
      eq(optionGroup.ownerId, ownerId),
      eq(optionGroup.status, 'open'),
      sql`exists (select 1 from ${garment} where ${and(
        eq(garment.suggestionGroupId, optionGroup.id),
        wanted(),
      )})`,
    )}
  )`;
}

/** A need a different garment was bought for, and the pick to prefill the form from. */
export interface NeedBoughtFor {
  id: number;
  name: string;
  /** The chosen pick, else its best open one (Muse's rank first); null when none is left. */
  pickId: number | null;
}

/**
 * The owner's need `groupId` while it is still to buy for (undefined when
 * it is not theirs, or settled or set aside): open, or chosen and the pick
 * not bought yet, the rule of the machine's stillToBuy
 * (src/wardrobe/suggestions.ts), which decide applies again under the
 * owner lock. "Bought a different one" (src/web/wardrobe/destination.ts).
 * One statement.
 */
export async function findNeedToBuyFor(
  db: Queryable,
  ownerId: number,
  groupId: number,
): Promise<NeedBoughtFor | undefined> {
  const { need } = await selectScalars(db, {
    need: sql<NeedBoughtFor | null>`(
      select json_build_object(
        'id', ${optionGroup.id},
        'name', ${optionGroup.name},
        'pickId', (
          select ${garment.id} from ${garment}
          where ${and(eq(garment.suggestionGroupId, optionGroup.id), wanted())}
          order by ${garment.id} = ${optionGroup.resolvedGarmentId} desc nulls last,
            ${garment.suggestionRank} nulls last, ${garment.id}
          limit 1
        )
      )
      from ${optionGroup}
      where ${and(
        eq(optionGroup.id, groupId),
        eq(optionGroup.ownerId, ownerId),
        sql`${optionGroup.status} <> 'dismissed'`,
        inInbox,
      )}
    )`,
  });
  return need ?? undefined;
}

/** A need that has picks newer than the owner last looked: "New from Muse". */
export interface NewNeed {
  id: number;
  name: string;
}

/**
 * "New from Muse" (doc section 9: never part of the cached bare page): the
 * open needs holding a wanted pick suggested since the owner last looked
 * (every one when they never have), newest first, and the owner's
 * suggestions_seen_at moved to the newest of those picks, in one
 * statement. POST /wardrobe/wishlist/seen, sent by the inbox as it loads;
 * a POST never passes through the worker's cache, so no copy holds it.
 */
export async function markSuggestionsSeen(
  db: Db,
  ownerId: number,
): Promise<NewNeed[]> {
  const seenAt = sql`(select ${user.suggestionsSeenAt} from ${user} where ${eq(user.id, ownerId)})`;
  const { rows } = await db.execute<{ needs: NewNeed[] }>(sql`
    with fresh as (
      select ${optionGroup.id} as id, ${optionGroup.name} as name,
        max(${garment.suggestedAt}) as newest
      from ${optionGroup}
      join ${garment} on ${eq(garment.suggestionGroupId, optionGroup.id)}
      where ${and(
        eq(optionGroup.ownerId, ownerId),
        eq(optionGroup.status, 'open'),
        eq(garment.ownerId, ownerId),
        wanted(),
        isNotNull(garment.suggestedAt),
        sql`${garment.suggestedAt} > coalesce(${seenAt}, '-infinity'::timestamptz)`,
      )}
      group by ${optionGroup.id}
    ),
    moved as (
      update ${user} set suggestions_seen_at = (select max(newest) from fresh)
      where ${eq(user.id, ownerId)} and exists (select 1 from fresh)
      returning 1
    )
    select coalesce(
      json_agg(json_build_object('id', id, 'name', name) order by newest desc, id),
      '[]'
    ) as needs
    from fresh, (select count(*) from moved) as written
  `);
  return rows[0].needs;
}
