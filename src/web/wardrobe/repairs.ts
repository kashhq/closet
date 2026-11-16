import { type Static, Type } from '@sinclair/typebox';
import { and, eq, inArray, ne, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db, Queryable } from '../../db/client';
import { garment, garmentRepair } from '../../db/schema';
import { REPAIR_KINDS, type RepairKind } from '../../wardrobe/care';
import type { GarmentStatus } from '../../wardrobe/status';
import { ownerTransaction } from '../auth/queries';
import type { FieldErrors } from '../auth/validation';
import { type IsoDate, parseIsoDate } from '../../calendar-date';
import { t, type Translated } from '../i18n';
import { RowId } from '../schemas';
import { CARE_NOTE_MAX, PRICE_INPUT_MAX, readPrice } from './garment-input';

/**
 * A garment's repair and alteration log (#23; docs/plans/2026-09-26-
 * wardrobe-features.md, section 17): its form, reads and the two writes.
 * The owner's own record, like wears: the routes (repair-routes.tsx) refuse
 * anyone else, the garment page reads it through garmentContext, and every
 * write holds the owner lock (ownerTransaction).
 */

/** One entry of the log, as the pages show it. */
export interface RepairEntry {
  id: number;
  day: IsoDate;
  kind: RepairKind;
  note: string;
  /** numeric(10, 2) as text ('25.00'), or none given. */
  cost: string | null;
}

/** POST /wardrobe/:id/repairs: the edit page's "Log a repair" form. */
export const RepairBody = Type.Object({
  day: Type.Optional(Type.String({ maxLength: 32 })),
  kind: Type.Union(REPAIR_KINDS.map((kind) => Type.Literal(kind))),
  note: Type.Optional(Type.String({ maxLength: CARE_NOTE_MAX })),
  cost: Type.Optional(Type.String({ maxLength: PRICE_INPUT_MAX })),
});
export type RepairBody = Static<typeof RepairBody>;

export const RepairParams = Type.Object({ id: RowId, repairId: RowId });

export type RepairField = 'day' | 'note' | 'cost';

/** The form as it shows: the posted strings, or a new entry's. */
export interface RepairFormValues {
  day: string;
  kind: RepairKind;
  note: string;
  cost: string;
}

/** A new entry's form: done today, a repair, nothing else said. */
function blankRepair(today: IsoDate): RepairFormValues {
  return { day: today, kind: 'repair', note: '', cost: '' };
}

export type NewRepair = Omit<RepairEntry, 'id'>;

/**
 * The garment page's log: its entries, and what they cost in all. `total`
 * is wearSummarySql's `repairCost` (repairCostSql), the very sum cost per wear
 * adds, so "Spent on it" and the wear line never disagree.
 */
export interface RepairLog {
  entries: RepairEntry[];
  total: string | null;
}

/** The edit page's log: what is logged (each removable), and the form to log another. */
export interface RepairPanel {
  garmentId: number;
  entries: RepairEntry[];
  /** The form: a blank entry for today, or a refused post with its messages. */
  draft: RepairFormValues;
  errors?: FieldErrors<RepairField>;
  /** The latest day the form accepts (the household's today). */
  today: IsoDate;
}

/**
 * The edit page's repair editor before its log is read: renderGarmentForm
 * reads the entries (repairLogSql) with the form's other lists, in one
 * statement (formContext, form-context.ts).
 */
export type RepairPanelRequest = Omit<RepairPanel, 'entries'>;

/**
 * The edit page's repair editor for `garment`, or undefined where there is
 * none: for anyone but its owner, and for a wishlist item (not owned yet).
 * The one rule for the edit page, its refused save and a refused entry.
 */
export function repairPanel(
  garment: { id: number; status: GarmentStatus },
  isOwner: boolean,
  today: IsoDate,
  refused?: { values: RepairFormValues; errors: FieldErrors<RepairField> },
): RepairPanelRequest | undefined {
  if (!isOwner || garment.status === 'wishlist') return undefined;
  return {
    garmentId: garment.id,
    draft: refused?.values ?? blankRepair(today),
    errors: refused?.errors,
    today,
  };
}

/**
 * The posted entry as stored, or the form again with its messages: a real
 * day no later than `today` (a log records what was done), what was done (a
 * line, never blank), and a cost read as the price is (readPrice).
 */
export function readRepairForm(
  body: RepairBody,
  today: IsoDate,
):
  | { ok: true; entry: NewRepair }
  | { ok: false; values: RepairFormValues; errors: FieldErrors<RepairField> } {
  const values = repairFormValues(body);
  const day = readRepairDay(values.day, today);
  const note = values.note.trim();
  const cost = readPrice(values.cost);
  if ('day' in day && note && 'price' in cost) {
    return {
      ok: true,
      entry: { day: day.day, kind: values.kind, note, cost: cost.price },
    };
  }
  const errors: FieldErrors<RepairField> = {
    ...('error' in day && { day: [day.error] }),
    ...(!note && { note: [t('validation.REPAIR_NOTE_REQUIRED')] }),
    ...('error' in cost && { cost: [cost.error] }),
  };
  return { ok: false, values, errors };
}

/** The posted entry as its form shows it again. */
function repairFormValues(body: RepairBody): RepairFormValues {
  return {
    day: body.day?.trim() ?? '',
    kind: body.kind,
    note: body.note ?? '',
    cost: body.cost ?? '',
  };
}

/** The entry's day: a real date, not after `today`; or its message. */
function readRepairDay(
  typed: string,
  today: IsoDate,
): { day: IsoDate } | { error: Translated } {
  if (!typed) return { error: t('validation.REPAIR_DAY_REQUIRED') };
  const day = parseIsoDate(typed);
  if (day === undefined) return { error: t('validation.INVALID_DATE') };
  // ISO dates compare as strings.
  if (day > today) return { error: t('validation.REPAIR_DAY_FUTURE') };
  return { day };
}

/**
 * A garment's log, newest day first (the latest logged first within a
 * day), as a scalar subquery (a JSON array, empty for none): the garment
 * page reads it with its other lists in one statement (garmentContext,
 * src/web/wardrobe/garment-context.ts). The caller has established that
 * the requester owns the garment. The cost is cast to text: in JSON a
 * numeric is a number, and '25.00' would arrive as 25.
 */
export function repairLogSql(
  garmentId: number | AnyPgColumn,
): SQL<RepairEntry[]> {
  return sql<RepairEntry[]>`(
    select coalesce(
      json_agg(
        json_build_object(
          'id', ${garmentRepair.id},
          'day', ${garmentRepair.day},
          'kind', ${garmentRepair.kind},
          'note', ${garmentRepair.note},
          'cost', ${garmentRepair.cost}::text
        )
        order by ${garmentRepair.day} desc, ${garmentRepair.id} desc
      ),
      '[]'
    )
    from ${garmentRepair}
    where ${eq(garmentRepair.garmentId, garmentId)}
  )`;
}

/**
 * What a garment's repairs done up to `through` cost in all, as a scalar
 * subquery on its id column: numeric's exact sum as text ('37.50'), null
 * when no entry gives a cost. Cost per wear's repair part (totalCost,
 * src/wardrobe/insights.ts), a column of the statement that already reads
 * the garment (insightGarments, wearSummarySql) rather than a query of its
 * own. The owner's own record: only an owner-only read may select it.
 */
export function repairCostSql(
  garmentId: AnyPgColumn,
  through: IsoDate,
): SQL<string | null> {
  return sql<
    string | null
  >`(select sum(${garmentRepair.cost})::text from ${garmentRepair} where ${garmentRepair.garmentId} = ${garmentId} and ${garmentRepair.day} <= ${through}::date)`;
}

/**
 * Logs `entry` on the owner's garment, under the owner lock; the new id,
 * or undefined when the garment is not the owner's owned garment (gone, or
 * a wishlist item: nothing to mend before it is bought).
 */
export function addRepair(
  db: Queryable,
  ownerId: number,
  garmentId: number,
  entry: NewRepair,
): Promise<number | undefined> {
  return ownerTransaction(db, ownerId, 'addRepair', async (tx) => {
    const [owned] = await tx
      .select({ id: garment.id })
      .from(garment)
      .where(
        and(
          eq(garment.id, garmentId),
          eq(garment.ownerId, ownerId),
          ne(garment.status, 'wishlist'),
        ),
      )
      // Held until the insert: a garment deleted meanwhile waits for it.
      .for('share');
    if (!owned) return undefined;
    const [row] = await tx
      .insert(garmentRepair)
      .values({ garmentId, ...entry })
      .returning({ id: garmentRepair.id });
    return row.id;
  });
}

/**
 * Removes entry `repairId` from the log of the owner's garment `garmentId`,
 * under the owner lock; false when there is no such entry there.
 */
export function deleteRepair(
  db: Db,
  ownerId: number,
  garmentId: number,
  repairId: number,
): Promise<boolean> {
  return ownerTransaction(db, ownerId, 'deleteRepair', async (tx) => {
    const deleted = await tx
      .delete(garmentRepair)
      .where(
        and(
          eq(garmentRepair.id, repairId),
          eq(garmentRepair.garmentId, garmentId),
          inArray(
            garmentRepair.garmentId,
            tx
              .select({ id: garment.id })
              .from(garment)
              .where(eq(garment.ownerId, ownerId)),
          ),
        ),
      )
      .returning({ id: garmentRepair.id });
    return deleted.length > 0;
  });
}
