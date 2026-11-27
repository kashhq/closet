import { type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { selectScalars } from '../../db/select-scalars';
import type { IsoDate } from '../../calendar-date';
import { capsulesOfGarmentSql, type GarmentCapsule } from '../capsules/queries';
import {
  type AvoidedPartner,
  avoidedWithSql,
  type GoesWithInputs,
  goesWithInputsSql,
  readGoesWithInputs,
} from '../gallery/queries';
import { GARMENT_OUTFITS_SHOWN } from '../outfits/garment-outfits';
import type { WardrobeRole } from '../sharing/access';
import { type GarmentOutfits, outfitsWithGarmentSql } from '../outfits/queries';
import { type BrandSize, brandSizeSql } from '../sizes/queries';
import { type WearSummary, wearSummarySql } from '../wears/queries';
import {
  type SuggestionContext,
  suggestionContextSql,
} from '../wishlist/inbox';
import {
  type GarmentRef,
  garmentRefSql,
  type Replacement,
  replacementsOfSql,
} from '../wishlist/queries';
import type { AgentLabel } from '../write-origin';
import { type GarmentDetail, garmentAgentSql } from './queries';
import { type RepairEntry, repairLogSql, type RepairLog } from './repairs';

/**
 * The owner's own records about a garment in their closet (#84, #150,
 * #155): never read for a grantee, whose page renders none of them, nor
 * for a wishlist item, which is not in the closet.
 */
interface OwnerRecords {
  wear: WearSummary;
  outfits: GarmentOutfits;
  avoided: AvoidedPartner[];
  repairs: RepairLog;
}

/**
 * What GET /wardrobe/:id shows beside the garment itself (garment-page.tsx).
 * What a page shows depends on where the garment is: a wishlist item has
 * no wears, washes or capsules (closet reads) and says what it replaces; a
 * closet garment lists the wishlist items that would replace it.
 * - `capsules`: the capsules row, for anything owned (anyone who sees it);
 * - `replaces`: the garment it replaces (a wishlist item's, or a bought one's);
 * - `replacedBy`: "On the wishlist", for a closet garment;
 * - `own`: the owner's records (OwnerRecords), the owner's alone;
 * - `goesWith`: "Goes with my closet"'s inputs for a wishlist item (#18b),
 *   the owner's alone: it reads their closet and clashes;
 * - `brandSize`: the owner's size in a wishlist item's brand (#24), their
 *   body, so never read for a grantee;
 * - `suggestion`: Muse's note and the need it is a pick of, with its
 *   siblings (#333), for a suggestion; anyone who sees it reads Muse's
 *   notes (owner decision, 2026-10-05);
 * - `agent`: the agent that made it over MCP (#682), as the viewer may see
 *   it (agentLabelSql: a grantee's agent's token name is that grantee's).
 */
export interface GarmentContext {
  capsules: GarmentCapsule[];
  replaces: GarmentRef | undefined;
  replacedBy: Replacement[];
  own: OwnerRecords | undefined;
  goesWith: GoesWithInputs | undefined;
  brandSize: BrandSize | undefined;
  suggestion: SuggestionContext | undefined;
  agent: AgentLabel | null;
}

/** Who reads the page: the wardrobe's access, and the viewer the agent's name depends on. */
interface ContextReader {
  isOwner: boolean;
  ownerId: number;
  role: WardrobeRole;
  viewerId: number;
}

/**
 * The garment page's reads after the garment itself, in one statement
 * (selectScalars): they share no rows, and each was its own round trip
 * until #160. Which parts are read is decided here, from the garment and
 * the access, and nowhere else: a part the page does not show for this
 * garment or requester is never read, so **owner-only data (wears, washes,
 * outfits, cost, avoided pairs, the repair log, the closet and the brand
 * notes behind "Goes with my closet") is read only when `isOwner`**. A new
 * owner-only read joins `own`, never a view. Nothing is sent when no part
 * applies (a grantee's wishlist item that replaces nothing).
 */
export async function garmentContext(
  db: Db,
  garment: GarmentDetail,
  access: ContextReader,
  today: IsoDate,
): Promise<GarmentContext> {
  const row = await selectScalars(db, contextColumns(garment, access, today));
  const own = row.own && {
    ...row.own,
    // "Spent on it" is the wear line's repair sum, one figure for both.
    repairs: { entries: row.own.repairs, total: row.own.wear.repairCost },
  };
  return {
    capsules: row.capsules ?? [],
    replaces: row.replaces ?? undefined,
    replacedBy: row.replacedBy ?? [],
    own,
    goesWith: row.goesWith && readGoesWithInputs(row.goesWith),
    brandSize: row.brandSize ?? undefined,
    suggestion: row.suggestion ?? undefined,
    agent: row.agent ?? null,
  };
}

/** Each part's column, or undefined where the page shows none (see above). */
function contextColumns(
  {
    id,
    status,
    replacesGarmentId,
    brand,
    suggestedAt,
    suggestionGroupId,
    madeByAgent,
  }: GarmentDetail,
  { isOwner, ownerId, role, viewerId }: ContextReader,
  today: IsoDate,
) {
  const owned = status !== 'wishlist';
  const when = <T>(read: boolean, column: () => T) =>
    read ? column() : undefined;
  return {
    capsules: when(owned, () => capsulesOfGarmentSql(ownerId, id)),
    replaces:
      replacesGarmentId === null
        ? undefined
        : garmentRefSql(replacesGarmentId, ownerId),
    replacedBy: when(status === 'closet', () => replacementsOfSql(id, ownerId)),
    own: when(owned && isOwner, () => ownerRecordsSql(ownerId, id, today)),
    goesWith: when(!owned && isOwner, () => goesWithInputsSql(ownerId, id)),
    brandSize:
      !owned && isOwner && brand ? brandSizeSql(ownerId, brand) : undefined,
    suggestion: when(suggestedAt !== null, () =>
      suggestionContextSql(
        ownerId,
        id,
        suggestionGroupId,
        { viewerId, ownsWardrobe: isOwner },
        role,
      ),
    ),
    agent: when(madeByAgent, () =>
      garmentAgentSql(id, { viewerId, ownsWardrobe: isOwner }),
    ),
  };
}

/** OwnerRecords as ownerRecordsSql reads them: the log's entries, without their total. */
type OwnerRecordsJson = Omit<OwnerRecords, 'repairs'> & {
  repairs: RepairEntry[];
};

/** OwnerRecords as one JSON value, a column of garmentContext's statement. */
function ownerRecordsSql(
  ownerId: number,
  id: number,
  today: IsoDate,
): SQL<OwnerRecordsJson> {
  return sql<OwnerRecordsJson>`json_build_object(
    'wear', ${wearSummarySql(id, today)},
    'outfits', ${outfitsWithGarmentSql(ownerId, id, GARMENT_OUTFITS_SHOWN)},
    'avoided', ${avoidedWithSql(ownerId, id)},
    'repairs', ${repairLogSql(id)}
  )`;
}
