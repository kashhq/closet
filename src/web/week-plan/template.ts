import { type Static, type TSchema, Type } from '@sinclair/typebox';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { lockedOwnerId, ownerLockCte, ownerLocked } from '../../db/owner-lock';
import { user, weekTemplate } from '../../db/schema';
import { selectScalars } from '../../db/select-scalars';
import {
  compareOccasions,
  DAY_OCCASIONS,
  type Occasion,
} from '../../wardrobe/occasions';
import {
  AROUND_OCCASIONS,
  type TemplateDay,
  templateSlots,
  type TemplateSlot,
  WEEKDAYS,
  type Weekday,
} from '../../wardrobe/week';
import { choice } from '../schemas';

/**
 * The week template's reads, its one writer and its form (#16; the pure
 * model is src/wardrobe/week.ts). The signed-in user's own, like the style
 * profile: shares never reach it. Edited on the Profile (views.tsx,
 * WeekTemplateSettings), read by "Plan my week" (plan.ts), the style page's
 * rhythm and get_style_profile, written by the seed through the same form.
 */

/** The user's template, weekday then occasion order; empty when never set. */
export async function findWeekTemplate(
  db: Queryable,
  userId: number,
): Promise<TemplateSlot[]> {
  const { template } = await selectScalars(db, {
    template: weekTemplateSql(userId),
  });
  return inTemplateOrder(template);
}

/**
 * The user's template slots as a scalar subquery (a JSON list, in no
 * order: inTemplateOrder sorts them), for a page that reads it with the
 * rest of what it shows (the calendar week, weekContext). Served by
 * week_template_pkey (user_id, weekday, occasion).
 */
export function weekTemplateSql(userId: number): SQL<TemplateSlot[]> {
  return sql<TemplateSlot[]>`(
    select coalesce(json_agg(json_build_object(
      'weekday', ${weekTemplate.weekday},
      'occasion', ${weekTemplate.occasion}
    )), '[]')
    from ${weekTemplate} where ${weekTemplate.userId} = ${userId})`;
}

/**
 * The templates of these users, one per user whether or not they ever set
 * one (empty: never set), in one statement: the changes feed's page
 * (src/web/sync/feed.ts), whose ids are users its keyset read in the same
 * snapshot (the template's stamp is a column of the user row, SYNC_STAMPS).
 */
export async function weekTemplatesByUserIds(
  db: Queryable,
  userIds: readonly number[],
): Promise<{ userId: number; slots: TemplateSlot[] }[]> {
  // Correlated by hand: a single-table select writes its columns without
  // their table (src/db/AGENTS.md, Gotchas).
  const slots = sql<TemplateSlot[]>`(
    select coalesce(json_agg(json_build_object(
      'weekday', ${weekTemplate}.weekday,
      'occasion', ${weekTemplate}.occasion
    )), '[]')
    from ${weekTemplate} where ${weekTemplate}.user_id = ${user}.id)`;
  const rows = await db
    .select({ userId: user.id, slots })
    .from(user)
    .where(inArray(user.id, [...userIds]));
  return rows.map(({ userId, slots }) => ({
    userId,
    slots: inTemplateOrder(slots),
  }));
}

/** Weekday, then the occasions' display order (compareOccasions). */
export function inTemplateOrder(
  slots: readonly TemplateSlot[],
): TemplateSlot[] {
  return [...slots].sort(
    (a, b) => a.weekday - b.weekday || compareOccasions(a.occasion, b.occasion),
  );
}

/**
 * The one writer of a template: replaced whole in one transaction (a
 * savepoint inside the seed's). Returns the slots saved.
 */
export function saveWeekTemplate(
  db: Queryable,
  userId: number,
  slots: readonly TemplateSlot[],
): Promise<number> {
  return db.transaction(async (tx) => {
    // Both statements take the owner lock (src/db/owner-lock.ts): the
    // delete's runs only once it scans, the insert's re-takes it, held.
    const lock = ownerLockCte(tx, userId);
    await tx
      .with(lock)
      .delete(weekTemplate)
      .where(and(eq(weekTemplate.userId, userId), ownerLocked(tx, lock)));
    if (slots.length > 0) {
      await tx
        .with(lock)
        .insert(weekTemplate)
        .values(
          slots.map((slot) => ({ userId: lockedOwnerId(lock), ...slot })),
        );
    }
    return slots.length;
  });
}

// ---- The form ---------------------------------------------------------------

/** A weekday's two fields, as the form names them. */
export function weekdayFieldNames(weekday: Weekday) {
  return { day: `day-${weekday}`, around: `around-${weekday}` } as const;
}

const DayField = choice(DAY_OCCASIONS);
const AroundField = Type.Optional(
  Type.Array(Type.Union(AROUND_OCCASIONS.map((o) => Type.Literal(o))), {
    maxItems: AROUND_OCCASIONS.length * 2,
  }),
);

/**
 * Per weekday: the day's outfit ('' for none, else one of DAY_OCCASIONS: a
 * select, so never two) and the occasions around it (checkboxes; one
 * arrives as a scalar, which ajv's coerceTypes 'array' makes a list).
 * Anything else is a 400 from the schema. Object.fromEntries cannot keep the
 * keys' types, so they are stated.
 */
export const WeekTemplateBody = Type.Object(
  Object.fromEntries(
    WEEKDAYS.flatMap((weekday) => {
      const names = weekdayFieldNames(weekday);
      return [
        [names.day, DayField],
        [names.around, AroundField],
      ] satisfies [string, TSchema][];
    }),
  ) as Record<`day-${Weekday}`, typeof DayField> &
    Record<`around-${Weekday}`, typeof AroundField>,
);
export type WeekTemplateBody = Static<typeof WeekTemplateBody>;

/** A posted template as its slots (repeats gone, occasion order). */
export function readWeekTemplateForm(body: WeekTemplateBody): TemplateSlot[] {
  return templateSlots(
    WEEKDAYS.map((weekday): TemplateDay => {
      const names = weekdayFieldNames(weekday);
      const day = body[names.day];
      return {
        weekday,
        day: day ? (day as Occasion) : null,
        around: body[names.around] ?? [],
      };
    }),
  );
}

/** Slots as the form posts them: the seed writes a template through it. */
export function weekTemplatePost(
  slots: readonly TemplateSlot[],
): WeekTemplateBody {
  const post: Record<string, string | string[]> = {};
  for (const weekday of WEEKDAYS) {
    const names = weekdayFieldNames(weekday);
    const on = slots.filter((slot) => slot.weekday === weekday);
    post[names.day] =
      on.find((slot) => DAY_OCCASIONS.includes(slot.occasion))?.occasion ?? '';
    post[names.around] = on
      .map((slot) => slot.occasion)
      .filter((o) => AROUND_OCCASIONS.includes(o));
  }
  return post;
}
