import type { Db, Queryable } from '../db/client';
import type { Logger } from '../logger';
import type { Actor } from './sharing/access';

/**
 * What a write action takes (#712): the database, and the Web logger its
 * outcome line goes to. A route passes its plugin's `{ db, logger }`, a
 * tool `{ db: ctx.db, logger: ctx.webLogger }`; a read action takes `db`
 * alone, since it logs nothing. `Queryable` for an action that may join a
 * caller's transaction (replaceEntryOutfit).
 */
export interface ActionDeps<Handle extends Queryable = Db> {
  db: Handle;
  logger: Logger;
}

/**
 * An operation's name: `<entity>[.<part>].<past participle>`, lowercase
 * (`trip.outfit.worn`, `calendar.entry.planned`). docs/conventions.md#logging.
 */
export type Op = `${string}.${string}`;

/** A field of an operation's line: an id, a count, a flag, a day or an occasion. */
type OpField = string | number | boolean | null | readonly (string | number)[];

/**
 * The one line an operation writes, from its domain action and so once
 * whichever surface called it: `{ op, userId, surface, ...fields }`, the op
 * its message too, so text output reads it and Loki filters on fields
 * (`| json | op="trip.outfit.worn"`). Ids and counts are fields, never
 * prose; an undefined field is left out. A refusal is never one: it is
 * thrown, and the error handler logs it with its `logDetail`.
 */
export function logOp(
  logger: Logger,
  actor: Actor,
  op: Op,
  fields: Readonly<Record<string, OpField | undefined>> = {},
): void {
  logger.info(
    { op, userId: actor.userId, surface: actor.surface, ...fields },
    op,
  );
}
