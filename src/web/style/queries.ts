import {
  and,
  type AnyColumn,
  asc,
  eq,
  inArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import {
  lockedOwnerId,
  OWNER_LOCKED,
  ownerLockCte,
  ownerLocked,
  ownerLockSql,
} from '../../db/owner-lock';
import { garment, outfitRule, styleProfile } from '../../db/schema';
import {
  type OutfitRule,
  type OutfitRuleKind,
  type StoredMatcher,
  storedMatcher,
  storedSides,
} from '../../wardrobe/outfit-rules';
import { NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import { inCloset, ownedGarment } from '../wardrobe/status';
import type { StyleProfileFields } from './validation';

/**
 * The user's style profile as a scalar subquery (null when never saved),
 * for a read that takes it with others in one statement: get_style_profile
 * (#172) and the style page (#251) read it with the week template. Every
 * field is JSON as stored (text and text arrays).
 */
export function styleProfileSql(
  userId: number,
): SQL<StyleProfileFields | null> {
  return sql<StyleProfileFields | null>`(
    select json_build_object(
      'styles', ${styleProfile.styles},
      'budget', ${styleProfile.budget},
      'palette', ${styleProfile.palette},
      'notes', ${styleProfile.notes}
    )
    from ${styleProfile} where ${eq(styleProfile.userId, userId)})`;
}

/** A rule as the feed's profile reads it: its id and its row (readOutfitRule). */
export interface SyncedRuleRow {
  id: number;
  rule: OutfitRuleRow;
}

/**
 * The style profiles of these users (one row per user, keyed by it) with
 * their outfit rules, oldest first, in one statement: the changes feed's
 * page (src/web/sync/feed.ts), which read the ids from the owner's own
 * wardrobe in the same snapshot (the style profile is owner-only). A rule's
 * write stamps its owner's profile row (SYNC_CHILDREN), so the rules ride
 * with it.
 */
export function styleProfilesByUserIds(
  db: Queryable,
  userIds: readonly number[],
): Promise<
  (StyleProfileFields & { userId: number; rules: SyncedRuleRow[] })[]
> {
  // Correlated by hand: a single-table select writes its columns without
  // their table (src/db/AGENTS.md, Gotchas).
  const rules = sql<SyncedRuleRow[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${outfitRule.id}, 'rule', ${ruleRowSql()}
    ) order by ${outfitRule.id}), '[]')
    from ${outfitRule}
    where ${outfitRule}.owner_id = ${styleProfile}.user_id
  )`;
  return db
    .select({
      userId: styleProfile.userId,
      styles: styleProfile.styles,
      budget: styleProfile.budget,
      palette: styleProfile.palette,
      notes: styleProfile.notes,
      rules,
    })
    .from(styleProfile)
    .where(inArray(styleProfile.userId, [...userIds]));
}

/** The one writer of a style profile (the page's post and the seed): the row upserted. */
export async function saveStyleProfile(
  db: Queryable,
  userId: number,
  fields: StyleProfileFields,
): Promise<void> {
  const lock = ownerLockCte(db, userId);
  await db
    .with(lock)
    .insert(styleProfile)
    .values({ userId: lockedOwnerId(lock), ...fields })
    .onConflictDoUpdate({
      target: styleProfile.userId,
      set: { ...fields, updatedAt: sql`now()` },
    });
}

/** One side of an outfit_rule row as outfitRulesSql's JSON (StoredMatcher's columns, in order). */
type StoredSide = [
  garmentId: StoredMatcher['garmentId'],
  category: StoredMatcher['category'],
  type: StoredMatcher['type'],
  color: StoredMatcher['color'],
  pattern: StoredMatcher['pattern'],
];

/** An outfit_rule row as outfitRulesSql's JSON, read back by readOutfitRules. */
export type OutfitRuleRow = [
  kind: OutfitRuleKind,
  a: StoredSide,
  b: StoredSide,
];

/**
 * The owner's outfit rules (#21) as a scalar subquery, oldest first, read
 * back with readOutfitRules: the generator's memory reads them beside the
 * avoided pairs (generatorMemorySql, src/web/gallery/queries.ts), so every
 * ideas surface has them without a statement of its own. Arrays, not
 * objects: json_agg of rows would carry the column names in every element.
 * Only ever the signed-in owner's: no share reads another's rules.
 */
export function outfitRulesSql(ownerId: number): SQL<OutfitRuleRow[]> {
  return sql<OutfitRuleRow[]>`(
    select coalesce(json_agg(${ruleRowSql()} order by ${outfitRule.id}), '[]')
    from ${outfitRule}
    where ${eq(outfitRule.ownerId, ownerId)}
  )`;
}

/** An outfit_rule row as an OutfitRuleRow: the kind, then each side in StoredSide's order. */
function ruleRowSql(): SQL<OutfitRuleRow> {
  const side = (columns: readonly AnyColumn[]) =>
    sql`json_build_array(${sql.join([...columns], sql`, `)})`;
  const { aGarmentId, aCategory, aType, aColor, aPattern } = outfitRule;
  const { bGarmentId, bCategory, bType, bColor, bPattern } = outfitRule;
  return sql<OutfitRuleRow>`json_build_array(
    ${outfitRule.kind},
    ${side([aGarmentId, aCategory, aType, aColor, aPattern])},
    ${side([bGarmentId, bCategory, bType, bColor, bPattern])}
  )`;
}

export function readOutfitRules(rows: readonly OutfitRuleRow[]): OutfitRule[] {
  return rows.map(readOutfitRule);
}

export function readOutfitRule([kind, a, b]: OutfitRuleRow): OutfitRule {
  return { kind, a: storedMatcher(sideOf(a)), b: storedMatcher(sideOf(b)) };
}

function sideOf([
  garmentId,
  category,
  type,
  color,
  pattern,
]: StoredSide): StoredMatcher {
  return { garmentId, category, type, color, pattern };
}

/** A garment as a rule's words name it: its name, or its category's label. */
export interface NamedGarment {
  id: number;
  name: string | null;
  category: string;
}

/** One of the owner's rules as the Style page lists it, with the garments it names. */
export interface ListedOutfitRule {
  id: number;
  rule: OutfitRuleRow;
  garments: NamedGarment[];
}

function namedGarmentSql() {
  return sql`json_build_object('id', ${garment.id}, 'name', ${garment.name}, 'category', ${garment.category})`;
}

/**
 * The owner's rules for the Style page's list (#21b), oldest first, each
 * with the garments its sides name, as a scalar subquery: the page reads
 * it with the profile in one statement. A side's garment cascades with it,
 * so every garment a rule names is there.
 */
export function outfitRuleListSql(ownerId: number): SQL<ListedOutfitRule[]> {
  return sql<ListedOutfitRule[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${outfitRule.id},
      'rule', ${ruleRowSql()},
      'garments', (
        select coalesce(json_agg(${namedGarmentSql()}), '[]')
        from ${garment}
        where ${or(
          eq(garment.id, outfitRule.aGarmentId),
          eq(garment.id, outfitRule.bGarmentId),
        )}
      )
    ) order by ${outfitRule.id}), '[]')
    from ${outfitRule}
    where ${eq(outfitRule.ownerId, ownerId)}
  )`;
}

/**
 * The style profile with its outfit rules, as scalar subqueries a caller
 * reads with its own parts in one statement (selectScalars): the page,
 * get_style_profile (with the week and the avoided pairs) and
 * GET /api/v1/style-profile (these alone).
 */
export function styleProfileParts(userId: number) {
  return {
    profile: styleProfileSql(userId),
    rules: outfitRuleListSql(userId),
  };
}

/**
 * The garments the add form offers a side (#21b): the owner's closet, by
 * category and name, as a scalar subquery read with the page.
 */
export function ruleGarmentChoicesSql(ownerId: number): SQL<NamedGarment[]> {
  return sql<NamedGarment[]>`(
    select coalesce(json_agg(${namedGarmentSql()} order by ${sql.join(
      [
        asc(garment.category),
        asc(sql`lower(${garment.name})`),
        asc(garment.id),
      ],
      sql`, `,
    )}), '[]')
    from ${garment}
    where ${and(eq(garment.ownerId, ownerId), inCloset())}
  )`;
}

/** A rule as the add form posts it, each side one matcher (readRuleSide). */
export interface NewOutfitRule {
  kind: OutfitRuleKind;
  a: StoredMatcher;
  b: StoredMatcher;
}

/**
 * Adds one of the actor's own rules (#21b), the one writer of outfit_rule:
 * its id, or 'duplicate' when they have it already (the unique index, so a
 * concurrent add cannot slip past a check made first). A never-rule's
 * sides are stored in one order (storedSides), so its mirror is a
 * duplicate too. A side naming a
 * garment that is not the actor's own (owned now or once, as avoidPair's)
 * is NotFound, and nothing is written. The two sides must differ (the
 * route says so; the table checks only two garments). A type is its
 * category's by construction (readRuleSide), which the table does not
 * check.
 *
 * One statement, as avoidPair: the owner lock first (a rule stamps the
 * style profile, a synced write: SYNC_CHILDREN), then the check locks the
 * sides' garments FOR SHARE, and the insert runs only when it found them
 * all, so a delete of one waits for the rule (then cascades it away) and
 * never leaves it naming a missing garment.
 */
export async function addOutfitRule(
  db: Queryable,
  actor: Actor,
  rule: NewOutfitRule,
): Promise<number | 'duplicate'> {
  const ownerId = actor.userId;
  const [a, b] = storedSides(rule.kind, rule.a, rule.b);
  const garmentIds = [a.garmentId, b.garmentId].filter((id) => id !== null);
  const owned = db
    .select({ id: garment.id })
    .from(garment)
    .where(
      and(
        eq(garment.ownerId, ownerId),
        inArray(garment.id, garmentIds),
        ownedGarment(),
        OWNER_LOCKED,
      ),
    )
    .orderBy(garment.id)
    .for('share');
  const side = (matcher: StoredMatcher) =>
    sql`${matcher.garmentId}::int, ${matcher.category}::text, ${matcher.type}::text, ${matcher.color}::text, ${matcher.pattern}::text`;
  const { rows } = await db.execute<{ owned: number; id: number | null }>(sql`
    with ${ownerLockSql(db, ownerId)},
    owned as (${owned}),
    added as (
      insert into ${outfitRule} (owner_id, kind,
        a_garment_id, a_category, a_type, a_color, a_pattern,
        b_garment_id, b_category, b_type, b_color, b_pattern)
      select ${ownerId}::int, ${rule.kind}::text, ${side(a)}, ${side(b)}
      where (select count(*) from owned) = ${garmentIds.length} and ${OWNER_LOCKED}
      on conflict do nothing
      returning id
    )
    select (select count(*) from owned)::int as owned,
      (select id from added) as id`);
  const [{ owned: found, id }] = rows;
  if (found !== garmentIds.length) {
    throw new NotFound('garment', {
      logDetail: `outfit rule side: garments ${garmentIds.join(', ')} are not all user ${ownerId}'s`,
    });
  }
  return id ?? 'duplicate';
}

/**
 * Deletes one of the actor's own rules, under the owner lock (it stamps the
 * style profile); anyone else's, or none, is NotFound.
 */
export async function deleteOutfitRule(
  db: Queryable,
  actor: Actor,
  id: number,
): Promise<void> {
  const lock = ownerLockCte(db, actor.userId);
  const deleted = await db
    .with(lock)
    .delete(outfitRule)
    .where(
      and(
        eq(outfitRule.id, id),
        eq(outfitRule.ownerId, actor.userId),
        ownerLocked(db, lock),
      ),
    )
    .returning({ id: outfitRule.id });
  if (deleted.length === 0) throw new NotFound('outfitRule');
}
