import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  not,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db, Queryable } from '../../db/client';
import { selectScalars } from '../../db/select-scalars';
import {
  file,
  garment,
  outfit,
  outfitCalendar,
  outfitSlot,
  selfie,
  tripOutfit,
} from '../../db/schema';
import type { AwayReason } from '../../wardrobe/availability';
import type { Occasion } from '../../wardrobe/occasions';
import type { LookReaction } from '../../wardrobe/look-reaction';
import type { GarmentStatus } from '../../wardrobe/status';
import type { OutfitDismissReason } from '../../wardrobe/suggestions';
import type { OutfitOrigin } from '../../wardrobe/outfit-origin';
import { ownerTransaction } from '../auth/queries';
import type { SignablePhotoRef } from '../files/image-url';
import { photoRefJson } from '../files/queries';
import type { IsoDate } from '../../calendar-date';
import { type Chooser, PERSONS_CHOICE } from '../calendar/planned-by';
import { insertEntry, type ScheduleOutcome } from '../calendar/queries';
import {
  type AgentLabel,
  agentLabelSql,
  BY_PERSON,
  OWNER_READS,
  type WriteOrigin,
} from '../write-origin';
import { entrySelfieSql, type SelfieRef } from '../selfies/queries';
import { prunePacked, tripsOfOutfit } from '../trips/packed';
import { detachOutfitWears } from '../wears/queries';
import { adoptOutfit } from '../week-plan/adopt';
import type { OutfitList } from './outfit-list';
import { OUTFIT_PAGE_SIZE } from './page-size';
import { adoptProposal } from './reactions';
import {
  offeredIntoSql,
  OutfitGarmentsGone,
  slotMayNameSql,
  slotRefusals,
} from './gone-garments';
import {
  keptOutfit,
  museOutfitWaiting,
  outfitIsHeld,
  ownersOutfit,
} from './references';

/**
 * Outfits' reads and writes. Outfits are private: every query is scoped to
 * the signed-in owner whatever wardrobe shares exist, and someone else's
 * outfit is a miss like a missing one (the routes answer 404 either way, so
 * ids reveal nothing; WardrobeAccess in src/web/sharing/access.ts). What an
 * outfit wears is its outfit_slot rows, in position order (src/db/schema.ts).
 */

/** A garment an outfit shows on the list and detail pages. */
export interface OutfitGarment {
  id: number;
  name: string | null;
  /** Where it goes in an OutfitCollage (its role). */
  category: string;
  /** A wishlist one is a piece to buy: the outfit is incomplete (piecesToBuy). */
  status: GarmentStatus;
  photo: SignablePhotoRef | null;
  /** Read only by the outfit page, which warns about it (outfitGarmentsSql's `away`). */
  away?: AwayReason | null;
}

export interface OutfitSummary {
  id: number;
  name: string | null;
  notes: string | null;
  /** Who made it (#659): the API's and MCP's `origin`. */
  origin: OutfitOrigin;
  /** The chosen garments in the order the outfit was built. */
  garments: OutfitGarment[];
}

// Caps on what a person types, shared by the inputs' maxlength and the
// routes' schemas (a longer post is a 400): Styling's Save sheet, the
// outfit form old cached pages still post, and pickIdea's generated names.
// The columns are text since drizzle/0005; the name stays at the 255 it has
// always been, so no saved outfit fails its own edit.
export const OUTFIT_NAME_MAX = 255;
export const OUTFIT_NOTES_MAX = 4000;
// The garments one outfit holds at most: create_outfit's and suggest_outfit's
// bound.
export const OUTFIT_GARMENTS_MAX = 20;
// The rows one save takes at most, empty ones included: position is a
// smallint, and no form needs more (the outfit form, the API's slots).
export const OUTFIT_SLOTS_MAX = 100;

/** One slot as a write takes it: a category and its garment (or none). */
export interface SlotInput {
  category: string;
  garmentId: number | null;
}

export interface OutfitInput {
  /** Absent on an update: left as it is. */
  name?: string | null;
  notes?: string | null;
  slots: SlotInput[];
  /** "Add to calendar": plan the outfit on this day, for this occasion, in the same transaction. */
  plan?: { day: IsoDate; occasion: Occasion };
  /**
   * Who is saving (#659): a new outfit's origin, and how far a reuse
   * takes the existing one over (adoptOutfit). Every caller says it.
   * `planner` also makes the plan's entry the planner's (`auto`).
   */
  origin: OutfitOrigin;
  /**
   * The person or the agent's token (#682): stamped on a new outfit and
   * the plan's entry (the planner's entry takes no token). Required, so a
   * new caller says.
   */
  madeBy: WriteOrigin;
}

/**
 * An edit (updateOutfit): what is absent is left as it is. The outfit form
 * and Styling post every row; the API may send only a name. Always a
 * person's (the outfit becomes `person`, lockForEdit).
 */
export type OutfitEdit = Omit<OutfitInput, 'slots' | 'origin' | 'madeBy'> & {
  slots?: SlotInput[];
};

/** A name or notes as stored: trimmed, null when blank; undefined (not sent) stays so. */
export function outfitText(
  value: string | null | undefined,
): string | null | undefined {
  return value === undefined ? undefined : value?.trim() || null;
}

export interface SaveResult {
  id: number;
  /** The slot rows written (none when an outfit was reused). */
  slots: number;
  schedule?: ScheduleOutcome;
  /** An update: the week planner's entries of the outfit that became the person's. */
  entriesClaimed?: number;
}

/** createOutfit's answer: the outfit, new or the one the garments already were. */
export interface CreateResult extends SaveResult {
  name: string | null;
  /** The garments were already an outfit of the owner's: it was reused, nothing was created. */
  alreadySaved: boolean;
  /** That outfit was one of Muse's proposals, which this save made the owner's (#335, adoptProposal). */
  adoptedProposal: boolean;
  /**
   * A person's save took over what the week planner had made of it: the
   * reused outfit (no longer the planner's to remove) or the entry on the
   * plan's day (now `user`). False for the planner's own saves.
   */
  adopted: boolean;
}

/** The agent that made the outfit (#682): outfits are their owner's alone. */
const outfitAgentSql = agentLabelSql(outfit.addedByTokenId, OWNER_READS);

/** Which page of outfits: those below id `before` (the previous page's `next`), `limit` of them. */
export interface OutfitPageAsk {
  before: number | undefined;
  limit: number;
}

export const FIRST_OUTFIT_PAGE: OutfitPageAsk = {
  before: undefined,
  limit: OUTFIT_PAGE_SIZE,
};

/** A page of outfits, newest first, and the id the next page starts below (null on the last). */
export interface OutfitPage<T> {
  outfits: T[];
  next: number | null;
}

/**
 * The one outfit page reader (#660): the outfits matching `where`, newest
 * first, keyset on the id (unique, so outfits alike in every other way
 * never repeat or skip between pages), each as `row` builds it, and the
 * next page's cursor, as one scalar subquery. Every paged list of outfits
 * reads through it: savedOutfitsSql (the Saved tab and the pickers) and
 * listOutfitsPage (list_outfits, GET /api/v1/outfits). It reads one row
 * more than the page, only to say there is a next. `outfit_owner_id_index`
 * narrows to the owner's rows; at household size the top-N sort over them
 * costs what an (owner, id) index would.
 */
function outfitPageSql<T>(
  row: SQL,
  where: SQL,
  page: OutfitPageAsk,
): SQL<OutfitPage<T>> {
  const keyset = and(
    where,
    page.before === undefined ? undefined : lt(outfit.id, page.before),
  );
  // Under the table's own name, so every correlated column in `row`
  // (outfitGarmentsSql's) still names its row.
  const rows = sql`(
    select *, row_number() over (order by ${outfit.id} desc) as page_position
    from ${outfit}
    where ${keyset}
    order by ${outfit.id} desc
    limit ${page.limit + 1}
  ) as ${outfit}`;
  const shown = sql`page_position <= ${page.limit}`;
  return sql<OutfitPage<T>>`(
    select json_build_object(
      'outfits', coalesce(
        json_agg(${row} order by ${outfit.id} desc) filter (where ${shown}),
        '[]'
      ),
      'next', case when count(*) > ${page.limit}
        then min(${outfit.id}) filter (where ${shown}) end
    )
    from ${rows}
  )`;
}

/** An outfit as the MCP tools and the API list answer it: with its notes, share link and proposal. */
function toolOutfitSql(): SQL {
  return sql`json_build_object(
    'id', ${outfit.id},
    'name', ${outfit.name},
    'notes', ${outfit.notes},
    'origin', ${outfit.origin},
    'shareableId', ${outfit.shareableId},
    'agent', ${outfitAgentSql},
    'garments', ${outfitGarmentsSql()},
    'proposal', ${proposalSql({ agent: false })}
  )`;
}

/**
 * The outfits matching `where` (findOutfit's one), each with its chosen
 * garments in slot order (empty slots show nothing) and its proposal when
 * Muse proposed it, in one statement. Raw SQL, never db.query: the
 * relational query writes every column of a `where` against its root
 * table, which breaks a predicate with a subquery of its own
 * (ownersOutfit).
 */
async function outfitsWithGarments(db: Db, where: SQL): Promise<ToolOutfit[]> {
  const { outfits } = await selectScalars(db, {
    outfits: sql<ToolOutfit[]>`(
      select coalesce(json_agg(${toolOutfitSql()} order by ${outfit.id} desc), '[]')
      from ${outfit}
      where ${where}
    )`,
  });
  return outfits;
}

/** An outfit as the MCP tools answer it: with its proposal when Muse proposed it (#335). */
export type ToolOutfit = OutfitDetail & {
  proposal: Omit<OutfitProposal, 'agent'> | null;
};

/**
 * The owner's outfits a page at a time (outfitPageSql), with their notes:
 * list_outfits and GET /api/v1/outfits. Their own (ownersOutfit: Muse's
 * proposals not theirs yet are the Outfits tab's own section), or with
 * `proposed` Muse's proposals waiting on the owner (museOutfitWaiting: the
 * Outfits tab's From Muse cards and Today's round count). One statement,
 * as the Saved tab's; the Saved tab, the pickers and a trip's add page
 * read savedOutfitsSql.
 */
export async function listOutfitsPage(
  db: Db,
  ownerId: number,
  page: OutfitPageAsk & {
    proposed: boolean;
    /** One of the Saved tab's lists (#659, savedOutfitsSql's rule); absent, every outfit. */
    list?: OutfitList;
  },
): Promise<OutfitPage<ToolOutfit>> {
  const { outfits } = await selectScalars(db, {
    outfits: outfitPageSql<ToolOutfit>(
      toolOutfitSql(),
      and(
        eq(outfit.ownerId, ownerId),
        page.proposed ? museOutfitWaiting() : ownersOutfit(),
        page.list && listFilter(page.list),
      )!,
      page,
    ),
  });
  return outfits;
}

/** The one rule of a Saved list (#659): savedOutfitsSql's, and GET /api/v1/outfits' `show`. */
function listFilter(list: OutfitList): SQL {
  return list === 'kept' ? keptOutfit() : not(keptOutfit());
}

/**
 * An outfit as a collage or a saved-outfit button shows it, without its
 * notes or share link: the Saved tab's tiles, the garment page's strip, a
 * trip's add page (savedOutfitsSql).
 */
export type GarmentOutfit = Pick<OutfitSummary, 'id' | 'name' | 'garments'>;

/** A Saved-tab tile (savedOutfitsSql): the outfit, and its agent when one made it (#822). */
export type SavedOutfit = GarmentOutfit & {
  agent: AgentLabel | null;
  /** One of Muse's proposals the owner kept: its own provenance, no badge. */
  proposed: boolean;
};

/** The garment page's "In N outfits" (#84): how many, and the newest few. */
export interface GarmentOutfits {
  count: number;
  outfits: GarmentOutfit[];
}

/**
 * The chosen garments of the enclosing query's outfit row in slot order,
 * as a JSON list (an empty slot shows nothing, as in outfitsWithGarments).
 * Correlated with `"outfit"."id"`: the caller's FROM names the outfit
 * table unaliased. The scalar subqueries below (the Saved tab, the outfit
 * page, the garment page's strip), and a trip's outfits (tripModel,
 * src/web/trips/model.ts). `away` adds each garment's away, the owner's
 * record: only the outfit page asks (#358), whose outfit is the session's
 * own (the other collages mark only pieces to buy: collagePieces).
 */
export function outfitGarmentsSql({
  away = false,
}: { away?: boolean } = {}): SQL<OutfitGarment[]> {
  return sql<OutfitGarment[]>`(
    select coalesce(
      json_agg(
        json_build_object(
          'id', ${garment.id},
          'name', ${garment.name},
          'category', ${garment.category},
          'status', ${garment.status},
          'photo', ${photoRefJson}${away ? sql`, 'away', ${garment.away}` : sql``}
        )
        order by ${outfitSlot.position}
      ),
      '[]'
    )
    from ${outfitSlot}
    join ${garment} on ${eq(garment.id, outfitSlot.garmentId)}
    left join ${file} on ${eq(file.id, garment.photoId)}
    where ${eq(outfitSlot.outfitId, outfit.id)}
  )`;
}

/** A Saved-tab tile or a saved-outfit button: no notes or share link, which nothing there shows. */
function savedOutfitSql(): SQL {
  return sql`json_build_object(
    'id', ${outfit.id},
    'name', ${outfit.name},
    'agent', ${outfitAgentSql},
    'proposed', ${outfit.proposedAt} is not null,
    'garments', ${outfitGarmentsSql()}
  )`;
}

/**
 * A page of the owner's outfits of `list` (#659: the kept ones, keptOutfit,
 * or the one-offs), newest first, as a tile or a saved-outfit button shows
 * it, as one scalar subquery (outfitPageSql, #660): the Saved tab reads it
 * with the outfits' activity (savedContext, page-context.ts, #164), the
 * calendar's plan page with the day's entries and a trip's add page with
 * the trip, each first page and each next page (their sentinels') in one
 * statement. The one list rule of the three: none filters on its own.
 */
export function savedOutfitsSql(
  ownerId: number,
  list: OutfitList,
  page: OutfitPageAsk,
): SQL<OutfitPage<SavedOutfit>> {
  return outfitPageSql<SavedOutfit>(
    savedOutfitSql(),
    and(eq(outfit.ownerId, ownerId), ownersOutfit(), listFilter(list))!,
    page,
  );
}

/**
 * Every one of the owner's own outfits' ids (ownersOutfit), newest first:
 * the warm list's `keep` (#286), which needs no garments.
 */
export function ownOutfitIdsSql(ownerId: number): SQL<number[]> {
  return sql<number[]>`(
    select coalesce(json_agg(${outfit.id} order by ${outfit.id} desc), '[]')
    from ${outfit}
    where ${and(eq(outfit.ownerId, ownerId), ownersOutfit())}
  )`;
}

/**
 * The owner's one-offs (not keptOutfit) that their entries from `from` to
 * `to` hold, as savedOutfitsSql's rows: the warm list's near-term outfits
 * (#659), which Today and the calendar open though no saved list shows them.
 */
export function heldOneOffsSql(
  ownerId: number,
  from: IsoDate,
  to: IsoDate,
): SQL<SavedOutfit[]> {
  const held = sql`${outfit.id} in (
    select ${outfitCalendar.outfitId} from ${outfitCalendar}
    where ${and(
      eq(outfitCalendar.ownerId, ownerId),
      gte(outfitCalendar.day, from),
      lte(outfitCalendar.day, to),
    )}
  )`;
  return sql<SavedOutfit[]>`(
    select coalesce(json_agg(${savedOutfitSql()} order by ${outfit.id} desc), '[]')
    from ${outfit}
    where ${and(eq(outfit.ownerId, ownerId), ownersOutfit(), not(keptOutfit()), held)}
  )`;
}

/**
 * The owner's outfits that hold `garmentId` (any slot), counted, and the
 * newest `limit` of them with their chosen garments in slot order, as one
 * scalar subquery: the garment page reads it with its other lists in one
 * statement (garmentContext, src/web/wardrobe/garment-context.ts). Only
 * what the strip shows (outfitsWithGarments' notes and shareable id feed
 * nothing there). `outfit_slot_garment_id_index` finds the outfits.
 */
export function outfitsWithGarmentSql(
  ownerId: number,
  garmentId: number,
  limit: number,
): SQL<GarmentOutfits> {
  // The owner's own outfits only: Muse's proposals are its section's.
  const holds = and(
    eq(outfit.ownerId, ownerId),
    sql`${outfit.id} in (select ${outfitSlot.outfitId} from ${outfitSlot} where ${eq(outfitSlot.garmentId, garmentId)})`,
    ownersOutfit(),
  );
  const newest = sql`(
    select ${outfit.id}, ${outfit.name}, ${outfitGarmentsSql()} as garments
    from ${outfit}
    where ${holds}
    order by ${outfit.id} desc
    limit ${limit}
  )`;
  return sql<GarmentOutfits>`json_build_object(
    'count', (select count(*)::int from ${outfit} where ${holds}),
    'outfits', (
      select coalesce(json_agg(shown order by shown.id desc), '[]')
      from ${newest} shown
    )
  )`;
}

/**
 * The outfit page's outfit: what it shows, its share link, and the agent
 * that made it over MCP (#682; null for the person's).
 */
type OutfitDetail = OutfitSummary & {
  /** The public link's id (/share), null while not shared (#669). */
  shareableId: string | null;
  agent: AgentLabel | null;
};

/** One of Muse's proposals as its outfit page says it (#335; proposals.ts). */
export interface OutfitProposal {
  note: string | null;
  reaction: LookReaction;
  ownerNote: string | null;
  dismissedReason: OutfitDismissReason | null;
  /** Muse: outfits are their owner's alone, so its token's name, or "Agent". */
  agent: AgentLabel | null;
}

/** The outfit page's outfit: with its proposal when Muse proposed it. */
export type OutfitPageDetail = OutfitDetail & {
  proposal: OutfitProposal | null;
};

/**
 * The owner's outfit `id` as the outfit page shows it, as JSON; null when
 * it is not theirs (a column of outfitContext's statement, page-context.ts).
 */
export function outfitDetailSql(
  id: number,
  ownerId: number,
): SQL<OutfitPageDetail | null> {
  return sql<OutfitPageDetail | null>`(
    select json_build_object(
      'id', ${outfit.id},
      'name', ${outfit.name},
      'notes', ${outfit.notes},
      'origin', ${outfit.origin},
      'shareableId', ${outfit.shareableId},
      'agent', ${outfitAgentSql},
      'garments', ${outfitGarmentsSql({ away: true })},
      'proposal', ${proposalSql({ agent: true })}
    )
    from ${outfit}
    where ${and(eq(outfit.id, id), eq(outfit.ownerId, ownerId))}
  )`;
}

/**
 * The outfit row's proposal as JSON, null for the owner's own: the outfit
 * page's (with the agent, agentLabelSql), the MCP tools'
 * and the changes feed's (outfitsByIds) without it.
 */
function proposalSql({ agent }: { agent: boolean }): SQL {
  const agentName = agent
    ? sql`, 'agent', ${agentLabelSql(outfit.addedByTokenId, OWNER_READS)}`
    : sql``;
  return sql`case when ${outfit.proposedAt} is null then null else json_build_object(
    'note', ${outfit.proposalNote},
    'reaction', ${outfit.reaction},
    'ownerNote', ${outfit.ownerNote},
    'dismissedReason', ${outfit.dismissedReason}${agentName}
  ) end`;
}

/** An outfit as the changes feed carries it (outfitsByIds, outfit-resource.ts). */
export interface SyncedOutfitRow {
  id: number;
  name: string | null;
  notes: string | null;
  origin: OutfitOrigin;
  /** Every row top to toe, an empty one with a null garment. */
  slots: SlotInput[];
  proposal: Omit<OutfitProposal, 'agent'> | null;
  /** The agent that made it over MCP (#682), null for a person's. */
  agent: AgentLabel | null;
}

/**
 * The outfits with these ids, their slots and their proposals, in one
 * statement whatever their owners (the changes feed's page,
 * src/web/sync/feed.ts, which read the ids from the owner's own wardrobe
 * in the same snapshot: outfits are owner-only). A slot write touches its
 * outfit (outfit_slot is its sync child), so the feed resends the outfit
 * with its rows; a garment's edit does not, so nothing here reads one.
 */
export function outfitsByIds(
  db: Queryable,
  ids: readonly number[],
): Promise<SyncedOutfitRow[]> {
  return db
    .select({
      id: outfit.id,
      name: outfit.name,
      notes: outfit.notes,
      origin: outfit.origin,
      slots: sql<SlotInput[]>`(
        select coalesce(json_agg(json_build_object(
          'category', ${outfitSlot.category},
          'garmentId', ${outfitSlot.garmentId}
        ) order by ${outfitSlot.position}), '[]')
        from ${outfitSlot} where ${outfitSlot.outfitId} = ${outfit.id}
      )`,
      proposal: sql<
        SyncedOutfitRow['proposal']
      >`${proposalSql({ agent: false })}`,
      agent: outfitAgentSql,
    })
    .from(outfit)
    .where(inArray(outfit.id, [...ids]));
}

/** The detail page's outfit, or undefined when it is not the owner's. */
export async function findOutfit(
  db: Db,
  id: number,
  ownerId: number,
): Promise<ToolOutfit | undefined> {
  const [found] = await outfitsWithGarments(
    db,
    and(eq(outfit.id, id), eq(outfit.ownerId, ownerId))!,
  );
  return found;
}

/** A day the outfit was worn, with its selfie (#19): the Worn strip's. */
export interface WornDay {
  entryId: number;
  day: IsoDate;
  selfie: SelfieRef | null;
}

/** A day the outfit is planned for and not worn yet: the outfit page's "Planned". */
export interface PlannedDay {
  entryId: number;
  day: IsoDate;
  occasion: Occasion;
}

/**
 * The outfit page's entries (redesign plan section 1: "an outfit is a
 * record, not an event"; the page reads its entries rather than holding a
 * state of its own). `worn`: the entries worn or with a selfie (one taken
 * and the entry unmarked later still shows), newest first, the Worn strip;
 * `planned`: the rest from `today` on, soonest first. Past entries never
 * worn are neither: the plan passed.
 */
export interface OutfitEntries {
  worn: WornDay[];
  planned: PlannedDay[];
}

/**
 * An entry the outfit was worn on: marked worn, or with a selfie (one
 * taken and the entry unmarked later is still the record of the day). The
 * one definition for the Worn strip (outfitEntriesSql) and the Saved
 * tile's count (outfitActivitySql), so the two never disagree; both left
 * join the entry's selfie.
 */
const entryWorn = sql<boolean>`(${outfitCalendar.wornAt} is not null or ${selfie.id} is not null)`;

/** An entry of the outfit's as outfitEntriesSql reads it, before readOutfitEntries splits them. */
export interface OutfitEntryRow {
  entryId: number;
  day: IsoDate;
  occasion: Occasion;
  worn: boolean;
  selfie: SelfieRef | null;
}

/**
 * The owner's outfit's entries worn or from `today` on, newest first, as
 * a JSON list (a column of outfitContext's statement, page-context.ts;
 * readOutfitEntries makes them OutfitEntries). Served by
 * outfit_calendar_outfit_id_index and the selfie's unique entry key.
 */
export function outfitEntriesSql(
  outfitId: number,
  ownerId: number,
  today: IsoDate,
): SQL<OutfitEntryRow[]> {
  return sql<OutfitEntryRow[]>`(
    select coalesce(json_agg(json_build_object(
      'entryId', ${outfitCalendar.id},
      'day', ${outfitCalendar.day},
      'occasion', ${outfitCalendar.occasion},
      'worn', ${entryWorn},
      'selfie', ${entrySelfieSql(outfitCalendar.id)}
    ) order by ${outfitCalendar.day} desc, ${outfitCalendar.id} desc), '[]')
    from ${outfitCalendar}
    left join ${selfie} on ${eq(selfie.outfitCalendarId, outfitCalendar.id)}
    where ${and(
      eq(outfitCalendar.outfitId, outfitId),
      eq(outfitCalendar.ownerId, ownerId),
      or(entryWorn, gte(outfitCalendar.day, today)),
    )}
  )`;
}

/** OutfitEntries of outfitEntriesSql's rows (newest first): worn as they come, planned reversed. */
export function readOutfitEntries(
  rows: readonly OutfitEntryRow[],
): OutfitEntries {
  const entries: OutfitEntries = { worn: [], planned: [] };
  for (const { entryId, day, occasion, worn, selfie: taken } of rows) {
    if (worn) entries.worn.push({ entryId, day, selfie: taken });
    else entries.planned.unshift({ entryId, day, occasion });
  }
  return entries;
}

/**
 * What the Saved grid says under an outfit (redesign plan, "Outfits"):
 * how often it was worn and the next day it is planned for.
 */
export interface OutfitActivity {
  wornCount: number;
  /** The soonest entry from `today` on not worn yet; null when none. */
  nextPlanned: IsoDate | null;
}

/**
 * Every outfit of the owner's that has a calendar entry, with its
 * OutfitActivity, as a JSON list (a column of savedContext's statement,
 * page-context.ts): grouped over the owner's entries (served by
 * outfit_calendar_owner_id_day_outfit_id_unique) and their selfies. Worn
 * is the Worn strip's (entryWorn), so the tile's count is the outfit
 * page's. An outfit never planned is absent. Depends on the day, never
 * the hour, so the Saved tab (a stale-while-revalidate tab root) stays
 * byte-stable within a day.
 */
export function outfitActivitySql(
  ownerId: number,
  today: IsoDate,
): SQL<(OutfitActivity & { outfitId: number })[]> {
  const perOutfit = sql`(
    select
      ${outfitCalendar.outfitId} as "outfitId",
      (count(*) filter (where ${entryWorn}))::int as "wornCount",
      min(${outfitCalendar.day}) filter (where not ${entryWorn} and ${outfitCalendar.day} >= ${today}) as "nextPlanned"
    from ${outfitCalendar}
    left join ${selfie} on ${eq(selfie.outfitCalendarId, outfitCalendar.id)}
    where ${eq(outfitCalendar.ownerId, ownerId)}
    group by ${outfitCalendar.outfitId}
  )`;
  return sql<(OutfitActivity & { outfitId: number })[]>`(
    select coalesce(json_agg(activity), '[]') from ${perOutfit} activity
  )`;
}

/**
 * Makes `slots` the outfit's positions 0..n-1, or refuses the save whole
 * (#219): a garment id that the outfit cannot hold throws
 * OutfitGarmentsGone, naming it, and the caller's transaction rolls back.
 * Never a slot stored empty behind the save's back. What it may hold is
 * slotMayNameSql's, judged here in the locked read under the caller's
 * owner lock, never by a read before it: the owner's closet garments,
 * those the outfit already holds (an archived one stays), and a garment
 * not bought yet that is offered to style with only while nothing holds
 * the outfit (#335: an incomplete outfit; a planned or packed one refuses
 * it). A pick set aside, a new archived garment, a deleted or another
 * user's one is refused.
 *
 * One statement (#168: a read before the insert used to cost a round
 * trip): the named garments are locked FOR SHARE in id order (as
 * pickedGarments and every multi-row garment locker take them, so none
 * deadlock), then each slot joins its garment. A delete or a move to the
 * wishlist in flight either waits for the save, or commits first and
 * makes the save refuse; without the lock the slot's foreign key check
 * waited on the delete and failed after it, a 500.
 *
 * `replace` (an edit, updateOutfit) swaps the old slots in the same
 * statement (#164: a delete before the insert cost a round trip): the
 * positions past the new last are deleted and the rest overwritten in
 * place, on the (outfit_id, position) key. The two touch disjoint
 * positions, so no row is written twice. The caller holds the outfit's
 * lock, so no other save writes its slots meanwhile. A new outfit
 * (createOutfit) has no slots to replace.
 */
async function insertSlots(
  tx: Queryable,
  outfitId: number,
  ownerId: number,
  slots: SlotInput[],
  { replace = false }: { replace?: boolean } = {},
): Promise<void> {
  const trim = sql`delete from ${outfitSlot} where ${and(
    eq(outfitSlot.outfitId, outfitId),
    gte(outfitSlot.position, slots.length),
  )}`;
  if (slots.length === 0) {
    if (replace) await tx.execute(trim);
    return;
  }
  // No garment named (every row empty): inArray is `false`, so the CTE
  // reads and locks nothing.
  const requested = [...new Set(slots.flatMap((slot) => slot.garmentId ?? []))];
  const held = tx
    .select({ id: garment.id })
    .from(garment)
    .where(
      and(
        eq(garment.ownerId, ownerId),
        inArray(garment.id, requested),
        slotMayNameSql({
          outfitId,
          offered: offeredIntoSql(outfitId),
        }),
      ),
    )
    .orderBy(garment.id)
    .for('share');
  const rows = sql.join(
    slots.map(
      (slot, position) =>
        sql`(${position}::smallint, ${slot.category}::text, ${slot.garmentId}::int)`,
    ),
    sql`, `,
  );
  // MATERIALIZED: the locks are taken whole, in the CTE's id order, before
  // any slot is joined to them.
  const { rows: written } = await tx.execute<{
    position: number;
    garmentId: number | null;
  }>(sql`
    with ${replace ? sql`trimmed as (${trim}),` : sql``}
    held as materialized (${held})
    insert into ${outfitSlot} (outfit_id, position, category, garment_id)
    select ${outfitId}::int, slot.position, slot.category, held.id
    from (values ${rows}) as slot (position, category, garment_id)
    left join held on held.id = slot.garment_id
    ${replace ? sql`on conflict (outfit_id, position) do update set category = excluded.category, garment_id = excluded.garment_id` : sql``}
    returning position, garment_id as "garmentId"`);
  const kept = new Map(written.map((row) => [row.position, row.garmentId]));
  const gone = slots.flatMap((slot, position) =>
    slot.garmentId !== null && kept.get(position) === null
      ? [slot.garmentId]
      : [],
  );
  if (gone.length === 0) return;
  const named = await slotRefusals(
    tx,
    ownerId,
    gone,
    await outfitHeld(tx, outfitId),
  );
  // Holdable again by the lookup (restored meanwhile): still refused as seen.
  throw new OutfitGarmentsGone(
    named.length > 0 ? named : gone.map((id) => ({ id })),
  );
}

/**
 * Whether something holds the outfit now (outfitIsHeld): what a refused
 * slot write's wishlist garments are named by (slotRefusals). Read only on
 * the refusal, in its transaction.
 */
async function outfitHeld(tx: Queryable, outfitId: number): Promise<boolean> {
  const { rows } = await tx.execute<{ held: boolean }>(
    sql`select ${outfitIsHeld(sql`${outfitId}::int`)} as held`,
  );
  return rows[0].held;
}

/**
 * The owner's outfit whose chosen garments are exactly `garmentIds` (empty
 * slots aside), the oldest if several (a garment delete can leave two
 * alike: ON DELETE SET NULL empties a slot): what a save of those garments
 * already is. A query for another statement, never run alone: createOutfit's
 * insert, and pickedGarments' read (src/web/gallery/queries.ts).
 */
export function sameGarmentsOutfit(
  db: Queryable,
  ownerId: number,
  garmentIds: readonly number[],
) {
  const sorted = [...new Set(garmentIds)].sort((a, b) => a - b);
  const wanted = sql`array[${sql.join(
    sorted.map((id) => sql`${id}`),
    sql`, `,
  )}]::int[]`;
  return db
    .select({
      id: outfit.id,
      name: outfit.name,
      // One of Muse's proposals not the owner's yet: a save adopts it
      // (adoptProposal), read here so a plain reuse costs nothing more.
      pending:
        sql<boolean>`(${outfit.proposedAt} is not null and ${outfit.reaction} <> 'loved')`.as(
          'pending',
        ),
      // Null for the owner's own: what a proposal meeting it answers (proposeOutfit).
      reaction: outfit.reaction,
    })
    .from(outfit)
    .innerJoin(outfitSlot, eq(outfitSlot.outfitId, outfit.id))
    .where(and(eq(outfit.ownerId, ownerId), isNotNull(outfitSlot.garmentId)))
    .groupBy(outfit.id)
    .having(
      sql`array_agg(distinct ${outfitSlot.garmentId} order by ${outfitSlot.garmentId}) = ${wanted}`,
    )
    .orderBy(outfit.id)
    .limit(1);
}

/**
 * The outfit row of a save, once: inserted only when no outfit of the
 * owner's already has exactly these garments, else that one, in one
 * statement (a CTE: the lookup, the insert where it found nothing, and
 * whichever row there is). Race-free only under the owner lock, which
 * createOutfit holds: two saves of the same garments take turns, and the
 * second's statement sees the first's commit. Without garments (the
 * outfit form's empty outfit) there is nothing to be the same as: a plain
 * insert.
 */
/** The agent's mark on an outfit it proposes (proposeOutfit): its token and its note. */
export interface OutfitProposalInput {
  tokenId: number;
  note: string | null;
}

/** insertOutfitOnce's row: the outfit inserted, or the one the garments already were. A type, as a raw row (execute). */
type OutfitOnce = {
  id: number;
  name: string | null;
  existing: boolean;
  pending: boolean;
  /** An existing outfit's reaction: null for the owner's own (never proposed). */
  reaction: LookReaction | null;
};

async function insertOutfitOnce(
  tx: Queryable,
  ownerId: number,
  fields: {
    name: string | null;
    notes: string | null;
    origin: OutfitOrigin;
    addedByTokenId: number | null;
  },
  garmentIds: readonly number[],
  proposal?: Omit<OutfitProposalInput, 'tokenId'>,
): Promise<OutfitOnce> {
  // No public link until Share is tapped (#669, setPublicShare).
  if (garmentIds.length === 0) {
    const [created] = await tx
      .insert(outfit)
      .values({ ownerId, ...fields })
      .returning({ id: outfit.id, name: outfit.name });
    return { ...created, existing: false, pending: false, reaction: null };
  }
  // A proposal is inserted marked (proposals.ts), waiting on the owner.
  const marked = proposal
    ? sql`now(), ${proposal.note}::text, 'proposed'`
    : sql`null, null, null`;
  const { rows } = await tx.execute<OutfitOnce>(sql`
    with existing as (${sameGarmentsOutfit(tx, ownerId, garmentIds)}),
    created as (
      insert into ${outfit} (owner_id, name, notes, origin, proposed_by_token_id, proposed_at, proposal_note, reaction)
      select ${ownerId}::int, ${fields.name}::text, ${fields.notes}::text, ${fields.origin}::text, ${fields.addedByTokenId}::int, ${marked}
      where not exists (select from existing)
      returning id, name
    )
    select id, name, false as existing, false as pending, null as reaction from created
    union all
    select id, name, true as existing, pending, reaction from existing`);
  return rows[0];
}

/** Who chose a save's planned entry: the planner's saves are its picks (`auto`). */
function planChooser(input: Pick<OutfitInput, 'origin' | 'madeBy'>): Chooser {
  return input.origin === 'planner' ? 'planner' : input.madeBy;
}

/**
 * Saves an outfit of `input.slots`, **once per garment set** (#219): when
 * an outfit of the owner's already has exactly these garments (empty slots
 * aside) it is the answer (`alreadySaved`: nothing is created, its name
 * and notes stay), planned on `input.plan`'s day when given (an outfit is
 * on a day once, so a second plan changes nothing), and a save that is
 * not the planner's takes it over as far as its `origin` reaches
 * (adoptOutfit: #77's planner rows, #659's origin). Otherwise the outfit, its slots and the
 * optional calendar entry commit together or not at all. A slot naming a
 * garment the owner does not own refuses the save whole
 * (OutfitGarmentsGone, insertSlots).
 *
 * The one writer of new outfits: pickIdea (every pick: the gallery,
 * Styling's Save, Today, trips, a replace, pick_outfit, the week planner),
 * the outfit form (POST /outfits), create_outfit and the seed. Always
 * under the owner lock (ownerTransaction: joined when the caller holds it,
 * as pickIdea does; a savepoint inside another transaction, as the seed's),
 * so a save and a pick of the same garments at the same moment make one
 * outfit: the second waits and finds the first's.
 *
 * Not a unique constraint on the garment set: the set is not stable data.
 * A garment delete empties its slots (ON DELETE SET NULL) and can leave
 * two outfits alike, and an edit (updateOutfit) may make one match
 * another; a key would have to refuse the delete or merge outfits that
 * carry calendar entries, wears, selfies and trips. The rule is that no
 * save creates a duplicate, and this function is where saves create.
 */
export function createOutfit(
  db: Queryable,
  ownerId: number,
  input: OutfitInput,
): Promise<CreateResult> {
  return ownerTransaction(db, ownerId, 'createOutfit', async (tx) => {
    const garmentIds = input.slots.flatMap((slot) => slot.garmentId ?? []);
    const saved = await insertOutfitOnce(
      tx,
      ownerId,
      {
        name: input.name ?? null,
        notes: input.notes ?? null,
        origin: input.origin,
        addedByTokenId: input.madeBy.agentTokenId,
      },
      garmentIds,
    );
    if (saved.existing) {
      return reuseOutfit(tx, ownerId, saved, input);
    }
    await insertSlots(tx, saved.id, ownerId, input.slots);
    const schedule = input.plan
      ? (
          await insertEntry(tx, {
            ownerId,
            outfitId: saved.id,
            ...input.plan,
            chooser: planChooser(input),
            outfitCreated: true,
          })
        ).outcome
      : undefined;
    return {
      id: saved.id,
      name: saved.name,
      slots: input.slots.length,
      schedule,
      alreadySaved: false,
      adoptedProposal: false,
      adopted: false,
    };
  });
}

export type ProposeOutcome =
  | { ok: true; id: number; slots: number }
  /** These garments were proposed already and not set aside (its reaction: proposed, sent back or loved): nothing written. */
  | { ok: true; id: number; alreadyProposed: LookReaction }
  /** The garments are an outfit of the owner's own: nothing to propose. */
  | { ok: false; reason: 'owners'; id: number }
  /** The owner set a proposal of these garments aside: never proposed again. */
  | {
      ok: false;
      reason: 'declined';
      id: number;
      dismissedReason: OutfitDismissReason | null;
    };

/**
 * The agent's outfit (suggest_outfit, #337): createOutfit's save, once per
 * garment set, marked as a proposal waiting on the owner (outfit.proposed_at,
 * its token and note, reaction `proposed`), never planned. What a slot may
 * name is insertSlots' rule as for any save (closet garments, and picks
 * offered to style with: a new outfit is held by nothing). When the
 * garments are an outfit already, nothing is written and the answer says
 * whose: a proposal not set aside is the answer (a retry creates nothing),
 * the owner's own or one they set aside is refused; a proposal is never
 * adopted here, only by a person's save (reuseOutfit). Under the owner
 * lock, as createOutfit.
 */
export function proposeOutfit(
  db: Queryable,
  ownerId: number,
  input: { name: string | null; slots: SlotInput[] },
  proposal: OutfitProposalInput,
): Promise<ProposeOutcome> {
  return ownerTransaction(db, ownerId, 'proposeOutfit', async (tx) => {
    const garmentIds = input.slots.flatMap((slot) => slot.garmentId ?? []);
    const saved = await insertOutfitOnce(
      tx,
      ownerId,
      {
        name: input.name,
        notes: null,
        origin: 'agent',
        addedByTokenId: proposal.tokenId,
      },
      garmentIds,
      proposal,
    );
    if (!saved.existing) {
      await insertSlots(tx, saved.id, ownerId, input.slots);
      return { ok: true, id: saved.id, slots: input.slots.length };
    }
    if (saved.reaction === null) {
      return { ok: false, reason: 'owners', id: saved.id };
    }
    if (saved.reaction !== 'declined') {
      return { ok: true, id: saved.id, alreadyProposed: saved.reaction };
    }
    const [declined] = await tx
      .select({ reason: outfit.dismissedReason })
      .from(outfit)
      .where(eq(outfit.id, saved.id));
    return {
      ok: false,
      reason: 'declined',
      id: saved.id,
      dismissedReason: declined.reason,
    };
  });
}

/**
 * A save's answer when its garments already are an outfit of the owner's:
 * planned on the plan's day when given, and, for any save but the
 * planner's, taken over (the outfit's origin and planner rows,
 * adoptOutfit; that day's entry, #77).
 * createOutfit's, and pickIdea's, which found the outfit with its garments
 * (pickedGarments) and so skips the insert. Under the owner lock.
 */
export async function reuseOutfit(
  tx: Queryable,
  ownerId: number,
  existing: { id: number; name: string | null; pending: boolean },
  input: Pick<OutfitInput, 'plan' | 'origin' | 'madeBy'>,
): Promise<CreateResult> {
  const { plan, origin } = input;
  const byPlanner = origin === 'planner';
  // A person's save of a proposal's garments makes it theirs (#335), before
  // any plan: a proposal not theirs may not be held (outfitMayBeHeld). The
  // week planner never adopts one (its ideas never equal a saved set:
  // savedSlotsSql counts proposals).
  const adoptedProposal =
    existing.pending &&
    !byPlanner &&
    (await adoptProposal(tx, ownerId, existing.id));
  const scheduled =
    plan &&
    (await insertEntry(tx, {
      ownerId,
      outfitId: existing.id,
      ...plan,
      chooser: planChooser(input),
    }));
  const outfitAdopted =
    !byPlanner && (await adoptOutfit(tx, ownerId, existing.id, origin)) > 0;
  const entryAdopted =
    scheduled?.outcome === 'already-scheduled' && scheduled.adopted;
  return {
    id: existing.id,
    name: existing.name,
    slots: 0,
    schedule: scheduled?.outcome,
    alreadySaved: true,
    adoptedProposal,
    adopted: outfitAdopted || entryAdopted,
  };
}

/**
 * POST /outfits/:id: fields, slots (replaced whole: the form posts every row)
 * and the optional calendar entry, in one transaction, with the packed marks
 * of garments the edit took off a trip's list (prunePacked, #10).
 * 'not-found' for an outfit that is not the owner's, before anything is
 * written. Editing an outfit is editing the calendar entries that hold it
 * (the calendar chip's edit link is this form), so the week planner's
 * entries of it become the person's (planned_by 'user', #16): its re-plan
 * never swaps an outfit someone changed. Under the owner lock, taken
 * before the outfit's: the re-plan deletes outfits under it, so the other
 * order could deadlock, and the take-over must not land mid re-plan. A
 * slot naming a garment the owner does not own refuses the edit whole
 * (OutfitGarmentsGone, insertSlots). An edit may leave it with another
 * outfit's garments: once per garment set is createOutfit's rule for what
 * a save creates, not a key (see there).
 *
 * Statements (#164): the outfit's lock with its fields and the take-over
 * (lockForEdit), the slots (insertSlots), the trips it is on, then the
 * prune (only when on one) and the plan (only when asked). An edit without
 * slots (the API's rename) leaves them, and the trips, alone.
 */
export function updateOutfit(
  db: Queryable,
  id: number,
  ownerId: number,
  input: OutfitEdit,
): Promise<SaveResult | 'not-found'> {
  return ownerTransaction(db, ownerId, 'updateOutfit', async (tx) => {
    const edited = await lockForEdit(tx, id, ownerId, {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.notes !== undefined && { notes: input.notes }),
    });
    if (!edited) return 'not-found';
    if (input.slots) {
      await insertSlots(tx, id, ownerId, input.slots, { replace: true });
      // A garment the edit took out may have left a trip's packing list
      // (#10). Read after the lock: a trip that added the outfit meanwhile
      // waited on it and committed first, so it is seen.
      await prunePacked(tx, await tripsOfOutfit(tx, id));
    }
    const schedule = input.plan
      ? (
          await insertEntry(tx, {
            ownerId,
            outfitId: id,
            ...input.plan,
            // An edit is always the person's (OutfitEdit).
            chooser: BY_PERSON,
          })
        ).outcome
      : undefined;
    return {
      id,
      slots: input.slots?.length ?? 0,
      schedule,
      entriesClaimed: edited.claimed,
    };
  });
}

/**
 * updateOutfit's first statement: the owner's outfit locked FOR UPDATE
 * (two saves of one outfit take turns; without the lock both replace the
 * slots and collide on the (outfit_id, position) key), then, only once it
 * is, its `fields` written with origin `person` and the week planner's entries of it made the
 * person's (the claim). Undefined when the outfit is not the owner's:
 * nothing written. One statement (#164; three before): each write reads
 * the locked row, so neither runs ahead of the lock, and no writer of
 * outfit_calendar can slip between the lock and the claim (they all hold
 * the owner lock, which the caller holds).
 */
async function lockForEdit(
  tx: Queryable,
  id: number,
  ownerId: number,
  fields: { name?: string | null; notes?: string | null },
): Promise<{ claimed: number } | undefined> {
  const locked = tx
    .select({ id: outfit.id })
    .from(outfit)
    .where(and(eq(outfit.id, id), eq(outfit.ownerId, ownerId)))
    .for('update');
  const isLocked = (column: AnyPgColumn) =>
    sql`${column} in (select id from locked)`;
  // An edit is a person's choice (#659): a one-off they rename or change
  // is theirs to keep, on Saved.
  const edited = tx
    .update(outfit)
    .set({ ...fields, origin: 'person' })
    .where(isLocked(outfit.id));
  const claimed = tx
    .update(outfitCalendar)
    .set(PERSONS_CHOICE)
    .where(
      and(
        isLocked(outfitCalendar.outfitId),
        eq(outfitCalendar.plannedBy, 'auto'),
      ),
    )
    .returning({ id: outfitCalendar.id });
  // getSQL(): Drizzle wraps an embedded builder in parentheses, which
  // Postgres takes around a select but not around an update.
  const { rows } = await tx.execute<{ found: number; claimed: number }>(sql`
    with locked as materialized (${locked}),
    edited as (${edited.getSQL()}),
    claimed as (${claimed.getSQL()})
    select
      (select count(*)::int from locked) as found,
      (select count(*)::int from claimed) as claimed`);
  const [row] = rows;
  return row.found > 0 ? { claimed: row.claimed } : undefined;
}

/**
 * Deletes the owner's outfit; its slots and calendar entries cascade, but
 * the days it was worn stay: detachOutfitWears (src/web/wears/queries.ts)
 * turns its entries' wears into day-level wears first, in the same
 * transaction. Never replace this with a plain delete: the cascade through
 * outfit_calendar would erase the garments' wear history (AGENTS.md, Wears
 * and washes). The entries' selfies stay too, by their foreign key
 * (selfie.outfit_calendar_id, ON DELETE SET NULL): each becomes a look kept
 * on its day, with its photo, which the calendar still shows (#19). Its
 * trips lose it by trip_outfit's cascade, and their packed marks for the
 * garments no other trip outfit holds go too (prunePacked, #10).
 * Undefined when the outfit is not the owner's; else the wears kept.
 * Under the owner lock, before the outfit's (its entries go with it; the
 * re-plan and Undo call it holding the lock already).
 *
 * Statements (#164): the outfit's lock, the wears detached, the trips it
 * is on read and the outfit deleted in one (the read sees the trip_outfit
 * rows the delete's cascade then removes), and the prune only when it was
 * on a trip.
 */
export function deleteOutfit(
  db: Queryable,
  id: number,
  ownerId: number,
): Promise<{ wearsKept: number } | 'a-proposal' | undefined> {
  return ownerTransaction(db, ownerId, 'deleteOutfit', async (tx) => {
    // Locked like updateOutfit's: a save of this outfit takes its turn, and
    // a trip adding it meanwhile (addTripOutfit, #234) commits first, and
    // the trips read below sees it, or waits on its FOR KEY SHARE lock of
    // the outfit and then answers 'no-outfit'.
    const [found] = await tx
      .select({ id: outfit.id, reaction: outfit.reaction })
      .from(outfit)
      .where(and(eq(outfit.id, id), eq(outfit.ownerId, ownerId)))
      .for('update');
    if (!found) return undefined;
    // Muse's proposal not loved yet (or set aside) is feedback for it: Not
    // for me sets it aside, kept; a delete would lose it (#335).
    if (found.reaction !== null && found.reaction !== 'loved') {
      return 'a-proposal';
    }
    const wearsKept = await detachOutfitWears(tx, id, ownerId);
    const { rows } = await tx.execute<{ trips: number[] }>(sql`
      with trips as (
        select distinct ${tripOutfit.tripId} as id from ${tripOutfit}
        where ${eq(tripOutfit.outfitId, id)}
      ),
      deleted as (delete from ${outfit} where ${eq(outfit.id, id)})
      select coalesce(json_agg(trips.id), '[]') as trips from trips`);
    // Its trips lost it (trip_outfit cascades) and maybe garments with it.
    await prunePacked(tx, rows[0].trips);
    return { wearsKept };
  });
}
