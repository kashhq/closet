import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { garment, optionGroup } from '../../db/schema';
import { selectScalars } from '../../db/select-scalars';
import {
  type DismissReason,
  type DecisionOutcome,
  decideSuggestion,
  type GroupState,
  type OptionGroupStatus,
  type PickState,
  MAX_OPTIONS_PER_GROUP,
  productUrlKey,
  type SuggestionDecision,
} from '../../wardrobe/suggestions';
import type { GarmentStatus } from '../../wardrobe/status';
import { ownerTransaction } from '../auth/queries';
import { onWishlist, setGarmentStatus, wanted } from '../wardrobe/status';

/**
 * The writers of suggestions and option groups (the agent, #333). decide is the
 * one writer of a decision: every This one, Not for me, Bought it's
 * settling of the group, Returned and Undo. markSuggestion is the one writer of provenance, and
 * createOptionGroup of a new need (the agent's tools, #337). All three
 * hold the owner lock, and so does every other writer of option_group and
 * of a suggestion's columns (only drizzle/0040's migration wrote them
 * otherwise, alone at boot), so no row lock is needed. Nothing is deleted:
 * a turned-down pick or need is dismissed, for the agent to learn from
 * (deleteGarment refuses a suggestion).
 */

/** What a decision is about: a group it names, else its garment's. */
type DecisionSubject = { groupId: number } | { garmentId: number };

function subjectOf(decision: SuggestionDecision): DecisionSubject {
  if ('groupId' in decision && decision.groupId !== undefined) {
    return { groupId: decision.groupId };
  }
  if ('garmentId' in decision) return { garmentId: decision.garmentId };
  // dismiss-group and undo-group always name their group.
  throw new Error(`${decision.kind} names no group`);
}

export type DecideOutcome =
  | {
      ok: true;
      groupId: number | null;
      dismissed: number[];
      restored: number[];
    }
  | Refusal;

/** Not the owner's group, or not a suggestion of theirs: a 404 like an unknown id. */
const NOT_FOUND = { ok: false, reason: 'not-found' } as const;
/** Not where the decision applies (a stale page, a double tap): a 409. */
const NOT_ALLOWED = { ok: false, reason: 'not-allowed' } as const;
type Refusal = typeof NOT_FOUND | typeof NOT_ALLOWED;

interface GroupRow {
  id: number;
  status: OptionGroupStatus;
  resolvedGarmentId: number | null;
  decidedAt: string | null;
}

interface PickRow {
  id: number;
  wanted: boolean;
  dismissedAt: string | null;
  dismissedReason: DismissReason | null;
}

/** The subject's group id, as SQL: named, or the group the garment is a pick of or resolved. */
function groupIdSql(ownerId: number, subject: DecisionSubject): SQL {
  if ('groupId' in subject) return sql`${subject.groupId}::integer`;
  return sql`coalesce(
    (select ${garment.suggestionGroupId} from ${garment}
      where ${and(eq(garment.id, subject.garmentId), eq(garment.ownerId, ownerId))}),
    (select ${optionGroup.id} from ${optionGroup}
      where ${and(eq(optionGroup.resolvedGarmentId, subject.garmentId), eq(optionGroup.ownerId, ownerId))})
  )`;
}

/**
 * The group (null when there is none of the owner's) and the garments the
 * machine judges: its picks, the garment that resolved it, and the
 * subject garment when it is a suggestion of the owner's outside any group.
 * One statement.
 */
async function readSubject(
  tx: Queryable,
  ownerId: number,
  subject: DecisionSubject,
  garmentId: number | undefined,
): Promise<{
  group: GroupRow | null;
  picks: PickRow[];
  garmentStatus: GarmentStatus | null;
}> {
  const id = groupIdSql(ownerId, subject);
  const resolvedOf = sql`(select ${optionGroup.resolvedGarmentId} from ${optionGroup} where ${optionGroup.id} = ${id})`;
  return selectScalars(tx, {
    // The decision's garment, the owner's: a purchase must name one bought.
    garmentStatus: sql<GarmentStatus | null>`(
      select ${garment.status} from ${garment}
      where ${eq(garment.ownerId, ownerId)} and ${garment.id} = ${garmentId ?? null}::integer
    )`,
    group: sql<GroupRow | null>`(
      select json_build_object(
        'id', ${optionGroup.id},
        'status', ${optionGroup.status},
        'resolvedGarmentId', ${optionGroup.resolvedGarmentId},
        'decidedAt', ${optionGroup.decidedAt}
      )
      from ${optionGroup}
      where ${optionGroup.id} = ${id} and ${eq(optionGroup.ownerId, ownerId)}
    )`,
    picks: sql<PickRow[]>`(
      select coalesce(json_agg(json_build_object(
        'id', ${garment.id},
        'wanted', ${garment.status} = 'wishlist',
        'dismissedAt', ${garment.dismissedAt},
        'dismissedReason', ${garment.dismissedReason}
      ) order by ${garment.id}), '[]')
      from ${garment}
      where ${eq(garment.ownerId, ownerId)} and (
        ${garment.suggestionGroupId} = ${id}
        or ${garment.id} = ${resolvedOf}
        ${
          'garmentId' in subject
            ? sql`or (${garment.id} = ${subject.garmentId} and ${garment.suggestedAt} is not null)`
            : sql``
        }
      )
    )`,
  });
}

function groupState(row: GroupRow): GroupState {
  return {
    status: row.status,
    resolvedGarmentId: row.resolvedGarmentId,
    decidedAt: row.decidedAt === null ? null : new Date(row.decidedAt),
  };
}

function pickState(row: PickRow): PickState {
  return {
    id: row.id,
    wanted: row.wanted,
    dismissedAt: row.dismissedAt === null ? null : new Date(row.dismissedAt),
    dismissedReason: row.dismissedReason,
  };
}

/**
 * The machine's answer as update statements (the group's, then each
 * dismissal and restore), for decide to send as one statement.
 */
function outcomeWrites(
  tx: Queryable,
  ownerId: number,
  groupId: number | undefined,
  outcome: Extract<DecisionOutcome, { ok: true }>,
): SQL[] {
  const writes: SQL[] = [];
  if (outcome.group && groupId !== undefined) {
    const change = outcome.group;
    writes.push(
      tx
        .update(optionGroup)
        .set({
          status: change.status,
          resolvedGarmentId: change.resolvedGarmentId,
          decidedAt: change.decided ? sql`now()` : null,
          dismissedReason: change.dismissedReason,
          ...(change.ownerNote !== undefined && {
            ownerNote: change.ownerNote,
          }),
        })
        .where(eq(optionGroup.id, groupId))
        .getSQL(),
    );
  }
  // A decision's dismissals share one reason and note (one pick's, or
  // the siblings' chose_another): one update per pair.
  const byReason = new Map<string, number[]>();
  for (const { garmentId, reason, note } of outcome.dismiss) {
    const key = JSON.stringify([reason, note]);
    byReason.set(key, [...(byReason.get(key) ?? []), garmentId]);
  }
  for (const [key, ids] of byReason) {
    const [reason, note] = JSON.parse(key) as [
      DismissReason | null,
      string | null,
    ];
    writes.push(
      tx
        .update(garment)
        .set({
          dismissedAt: sql`now()`,
          dismissedReason: reason,
          dismissedNote: note,
        })
        .where(and(inArray(garment.id, ids), eq(garment.ownerId, ownerId)))
        .getSQL(),
    );
  }
  if (outcome.restore.length > 0) {
    writes.push(
      tx
        .update(garment)
        .set({
          dismissedAt: null,
          dismissedReason: null,
          dismissedNote: null,
        })
        .where(
          and(
            inArray(garment.id, outcome.restore),
            eq(garment.ownerId, ownerId),
          ),
        )
        .getSQL(),
    );
  }
  return writes;
}

/**
 * What the writer refuses before asking the machine: a group named that is
 * not the owner's, and a purchase not of a garment of theirs in the closet
 * (the pick just bought, or the different one).
 */
function refusalOf(
  subject: DecisionSubject,
  decision: SuggestionDecision,
  read: Awaited<ReturnType<typeof readSubject>>,
): Refusal | undefined {
  if ('groupId' in subject && !read.group) return NOT_FOUND;
  if (decision.kind !== 'bought' || read.garmentStatus === 'closet') {
    return undefined;
  }
  return read.garmentStatus === null ? NOT_FOUND : NOT_ALLOWED;
}

/**
 * Decides `decision` for the owner, in their owner transaction (joined
 * when the caller holds it: "Bought it", buyWishlistItem).
 * The group is the one the decision names, else its garment's.
 * Dismissals and the group's decided_at are stamped with the
 * transaction's time (now()), so a choice and the siblings it set aside
 * share one instant, which is how its undo finds them. Returned archives
 * the bought garment (setGarmentStatus) in the same transaction.
 */
export function decide(
  db: Queryable,
  ownerId: number,
  decision: SuggestionDecision,
): Promise<DecideOutcome> {
  const subject = subjectOf(decision);
  const garmentId = 'garmentId' in decision ? decision.garmentId : undefined;
  return ownerTransaction(db, ownerId, 'decide', async (tx) => {
    const read = await readSubject(tx, ownerId, subject, garmentId);
    const refusal = refusalOf(subject, decision, read);
    if (refusal) return refusal;
    const outcome = decideSuggestion(
      read.group ? groupState(read.group) : undefined,
      read.picks.map(pickState),
      decision,
    );
    if (!outcome.ok) {
      return outcome.refusal === 'not-in-group' ? NOT_FOUND : NOT_ALLOWED;
    }
    if (decision.kind === 'returned') {
      const archived = await setGarmentStatus(tx, decision.garmentId, ownerId, {
        event: 'archive',
      });
      if (!archived.ok) return NOT_ALLOWED;
    }

    const writes = outcomeWrites(tx, ownerId, read.group?.id, outcome);
    // One statement: each write a data-modifying CTE (they touch disjoint
    // rows), embedded through getSQL(), which Drizzle does not parenthesise.
    if (writes.length > 0) {
      await tx.execute(
        sql`with ${sql.join(
          writes.map(
            (write, index) => sql`${sql.raw(`w${index}`)} as (${write})`,
          ),
          sql`, `,
        )} select 1`,
      );
    }
    return {
      ok: true,
      groupId: read.group?.id ?? null,
      dismissed: outcome.dismiss.map((d) => d.garmentId),
      restored: outcome.restore,
    };
  });
}

/** The group's open options (on the wishlist, not set aside): what MAX_OPTIONS_PER_GROUP bounds. */
function openOptionsSql(groupId: number): SQL<number> {
  return sql<number>`(select count(*)::int from ${garment} where ${and(
    eq(garment.suggestionGroupId, groupId),
    wanted(),
  )})`;
}

/**
 * A product with a link the agent may not suggest again: one it suggested
 * (in any state), or any wishlist garment the owner set aside, whoever
 * added it.
 */
export interface SuggestedProduct {
  id: number;
  sourceUrl: string;
  /** Set aside: never proposed again, with its reason (null for a migrated rejection). */
  dismissed: boolean;
  dismissedReason: DismissReason | null;
}

/** The owner's products a new suggestion's link is matched against (SuggestedProduct). */
function suggestedProductsSql(ownerId: number): SQL<SuggestedProduct[]> {
  return sql<SuggestedProduct[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${garment.id},
      'sourceUrl', ${garment.sourceUrl},
      'dismissed', ${garment.dismissedAt} is not null,
      'dismissedReason', ${garment.dismissedReason}
    ) order by ${garment.id}), '[]')
    from ${garment}
    where ${and(
      eq(garment.ownerId, ownerId),
      sql`${garment.sourceUrl} is not null`,
      sql`(${garment.suggestedAt} is not null or ${garment.dismissedAt} is not null)`,
    )}
  )`;
}

/** The product `url` would repeat (productUrlKey): one set aside first, else one suggested. */
function sameProduct(
  products: readonly SuggestedProduct[],
  url: string,
): SuggestedProduct | undefined {
  const key = productUrlKey(url);
  const same = products.filter((p) => productUrlKey(p.sourceUrl) === key);
  return same.find((p) => p.dismissed) ?? same[0];
}

/** Where a new pick of group `groupId` would go, judged before its product is fetched. */
export interface SuggestionRoom {
  /** missing: not the owner's; closed: resolved or set aside; full: MAX_OPTIONS_PER_GROUP open options. */
  group: 'missing' | 'closed' | 'full' | 'room';
  /** The product the link would repeat, if any. */
  same: SuggestedProduct | undefined;
}

function groupRoom(
  status: OptionGroupStatus | null,
  openOptions: number,
): SuggestionRoom['group'] {
  if (status === null) return 'missing';
  if (status !== 'open') return 'closed';
  return openOptions >= MAX_OPTIONS_PER_GROUP ? 'full' : 'room';
}

/**
 * markSuggestedProduct's rules read ahead, for suggest_garment (#337) to
 * refuse before it spends a link import: the group's state and room, and
 * the product `url` would repeat. One statement, no lock: the writer
 * judges again under the owner lock as it marks.
 */
export async function suggestionRoom(
  db: Queryable,
  ownerId: number,
  groupId: number,
  url: string,
): Promise<SuggestionRoom> {
  const read = await selectScalars(db, {
    status: sql<OptionGroupStatus | null>`(select ${optionGroup.status} from ${optionGroup} where ${and(
      eq(optionGroup.id, groupId),
      eq(optionGroup.ownerId, ownerId),
    )})`,
    openOptions: openOptionsSql(groupId),
    products: suggestedProductsSql(ownerId),
  });
  return {
    group: groupRoom(read.status, read.openOptions),
    same: sameProduct(read.products, url),
  };
}

/**
 * The agent's product marked as its suggestion (suggest_garment, #337):
 * under the owner lock, the never-again rule judged on the products as
 * they are now (another call's mark of the same link committed before this
 * one took the lock), then markSuggestion, which joins the lock. The new
 * garment is neither suggested nor set aside yet, so it never matches
 * itself.
 */
export function markSuggestedProduct(
  db: Queryable,
  ownerId: number,
  garmentId: number,
  provenance: Provenance,
  url: string,
): Promise<'marked' | 'refused' | 'full' | { same: SuggestedProduct }> {
  return ownerTransaction(db, ownerId, 'markSuggestedProduct', async (tx) => {
    const { products } = await selectScalars(tx, {
      products: suggestedProductsSql(ownerId),
    });
    const same = sameProduct(products, url);
    if (same) return { same };
    return markSuggestion(tx, ownerId, garmentId, provenance);
  });
}

/** What makes a wishlist garment a suggestion: who proposed it, where, why, and its rank. */
export interface Provenance {
  tokenId: number | null;
  groupId: number | null;
  note: string | null;
  rank: number | null;
}

/**
 * The one writer of a suggestion's provenance after drizzle/0040: marks
 * the owner's garment `garmentId` as suggested now, only while it is on
 * the wishlist and not a suggestion already (the agent's tools, #337), and
 * only into an open group of the same owner holding fewer than
 * MAX_OPTIONS_PER_GROUP open options (on the wishlist, not set aside).
 * Under the owner lock, so two at once cannot both take the last place.
 * Provenance is kept once the garment is bought, which is why no check
 * constraint can hold the wishlist rule: it is this writer's. One
 * statement inside the lock; `full` when only the group's room refused it.
 */
export function markSuggestion(
  db: Queryable,
  ownerId: number,
  garmentId: number,
  provenance: Provenance,
): Promise<'marked' | 'refused' | 'full'> {
  const { groupId } = provenance;
  const openOptions = openOptionsSql(groupId ?? -1);
  const groupOpen = sql`exists (select 1 from ${optionGroup} where ${and(
    eq(optionGroup.id, groupId ?? -1),
    eq(optionGroup.ownerId, ownerId),
    eq(optionGroup.status, 'open'),
  )})`;
  return ownerTransaction(db, ownerId, 'markSuggestion', async (tx) => {
    const markable = and(
      eq(garment.id, garmentId),
      eq(garment.ownerId, ownerId),
      onWishlist(),
      isNull(garment.suggestedAt),
      groupId === null ? undefined : groupOpen,
    );
    const marked = await tx
      .update(garment)
      .set({
        suggestedAt: sql`now()`,
        addedByTokenId: provenance.tokenId,
        suggestionGroupId: groupId,
        suggestionNote: provenance.note,
        suggestionRank: provenance.rank,
      })
      .where(
        and(
          markable,
          groupId === null
            ? undefined
            : sql`${openOptions} < ${MAX_OPTIONS_PER_GROUP}`,
        ),
      )
      .returning({ id: garment.id });
    if (marked.length === 1) return 'marked';
    // Only a refusal reads again, to say whether the group's room was why.
    if (groupId === null) return 'refused';
    const [markableRow] = await tx
      .select({ id: garment.id })
      .from(garment)
      .where(markable);
    return markableRow ? 'full' : 'refused';
  });
}

/** A new need as the agent states it (create_option_group, #337). */
export interface NeedInput {
  /** Trimmed, never blank. */
  name: string;
  /** Per piece, '300.00'; null for none. */
  budget: string | null;
  note: string | null;
  /** The agent's token (null as Provenance's: a need with no agent to name). */
  tokenId: number | null;
}

export type CreateGroupOutcome =
  | { ok: true; id: number }
  /** A need of that name is open already: add options to it instead. */
  | { ok: false; reason: 'open'; id: number }
  /** The owner chose an option for a need of that name and has not bought it yet: decided. */
  | { ok: false; reason: 'chosen'; id: number }
  /**
   * The owner set a need of that name aside: never proposed again (the
   * agent's feedback), whatever the reason; the owner's Undo reopens it.
   */
  | {
      ok: false;
      reason: 'dismissed';
      id: number;
      dismissedReason: DismissReason | null;
    };

/**
 * The one writer of a new option group: the owner's open need, its
 * provenance the agent's token. The agent's "never again" (doc section 5)
 * for needs is a guard on its name, not an identity: the same name,
 * trimmed and in any case, as a need open, chosen and not bought yet, or
 * set aside is refused with that need (a reworded need passes, and the
 * owner's reasons are the agent's to heed); a need settled by a purchase
 * is history and may come round again. Under the owner lock, so two
 * calls with one name make one need; the lookup and the insert are one
 * statement.
 */
export function createOptionGroup(
  db: Queryable,
  ownerId: number,
  need: NeedInput,
): Promise<CreateGroupOutcome> {
  return ownerTransaction(db, ownerId, 'createOptionGroup', async (tx) => {
    const { rows } = await tx.execute<{
      id: number;
      status: OptionGroupStatus | 'created';
      dismissedReason: DismissReason | null;
    }>(sql`
      with same as (
        select ${optionGroup.id} as id, ${optionGroup.status} as status,
          ${optionGroup.dismissedReason} as dismissed_reason
        from ${optionGroup}
        where ${and(
          eq(optionGroup.ownerId, ownerId),
          sql`lower(trim(${optionGroup.name})) = lower(${need.name})`,
          sql`(${optionGroup.status} <> 'resolved' or exists (
            select 1 from ${garment}
            where ${garment.id} = ${optionGroup.resolvedGarmentId}
              and ${onWishlist()}
          ))`,
        )}
        order by ${optionGroup.status} = 'open' desc, ${optionGroup.id} desc
        limit 1
      ),
      created as (
        insert into ${optionGroup} (owner_id, name, budget, note, suggested_by_token_id)
        select ${ownerId}::int, ${need.name}::text, ${need.budget}::numeric,
          ${need.note}::text, ${need.tokenId}::int
        where not exists (select from same)
        returning id
      )
      select id, 'created' as status, null as "dismissedReason" from created
      union all
      select id, status, dismissed_reason from same`);
    const [row] = rows;
    if (row.status === 'created') return { ok: true, id: row.id };
    if (row.status === 'open') return { ok: false, reason: 'open', id: row.id };
    if (row.status === 'resolved') {
      return { ok: false, reason: 'chosen', id: row.id };
    }
    return {
      ok: false,
      reason: 'dismissed',
      id: row.id,
      dismissedReason: row.dismissedReason,
    };
  });
}
