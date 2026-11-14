import type { Db } from '../../db/client';
import type { IsoDate } from '../../calendar-date';
import type { TapInstant } from '../../offline-writes';
import type { Occasion } from '../../wardrobe/occasions';
import { unkeyedPhoto } from '../files/image-variant';
import type { Photos } from '../files/photos';
import { type ActionDeps, logOp } from '../op-log';
import { outfitNotFound } from '../outfits/outfit-actions';
import { NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import { type EntryWornOutcome, setEntryWorn } from '../wears/queries';
import type { Chooser } from './planned-by';
import type { CalendarEntry } from './calendar-view';
import type { RemovedEntry } from './restore';
import { BY_PERSON } from '../write-origin';
import {
  deleteEntry,
  type DeletedEntry,
  findEntry,
  type ScheduledEntry,
  scheduleOutfit,
} from './queries';

/**
 * The calendar entry path (#188; docs/plans/2026-11-12-json-api.md section
 * 4): every surface's read of one entry and change to one, each taking the
 * Actor and refusing itself, so a page, an MCP tool and the API refuse
 * alike. Entries are private (AGENTS.md): only the actor's own are
 * reached, whatever wardrobe shares they hold, so another's entry is the
 * 404 of an unknown id, never a 403. The owner-scoped queries underneath
 * (queries.ts, setEntryWorn) trust their `ownerId`: only this path and
 * replaceEntryOutfit (replace.ts) reach them from a surface. Each write
 * logs its own outcome, once, as one `calendar.entry.*` line (logOp,
 * #712): its callers log nothing.
 */

/** Another's entry or no entry: one refusal for both (ids reveal nothing). */
export function calendarEntryNotFound(): NotFound {
  return new NotFound('calendarEntry');
}

/** scheduleOutfit refused as every surface refuses it, unlogged: planOutfit's and restoreEntry's. */
async function schedule(
  db: Db,
  actor: Actor,
  entry: { outfitId: number; day: IsoDate; occasion: Occasion },
  madeBy: Chooser,
): Promise<ScheduledEntry> {
  const scheduled = await scheduleOutfit(db, {
    ownerId: actor.userId,
    ...entry,
    chooser: madeBy,
  });
  if (scheduled === 'no-such-outfit') throw outfitNotFound();
  return scheduled;
}

/**
 * Plans the actor's outfit on a day (POST /calendar, schedule_outfit, POST
 * /api/v1/calendar-entries): scheduleOutfit's answer, the entry and the
 * occasion it is on that day included; an outfit not theirs is
 * NotFound('outfit'). Already there: `changed` false, the occasion the
 * entry kept, and `adopted` when it was the week planner's. The API's
 * `clientId` is not stored (an outfit is on a day once anyway), only
 * logged, so a client's retry can be found.
 */
export async function planOutfit(
  { db, logger }: ActionDeps,
  actor: Actor,
  entry: { outfitId: number; day: IsoDate; occasion: Occasion },
  madeBy: Chooser,
  { clientId }: { clientId?: string } = {},
): Promise<ScheduledEntry> {
  const scheduled = await schedule(db, actor, entry, madeBy);
  logOp(logger, actor, 'calendar.entry.planned', {
    entryId: scheduled.entryId,
    outfitId: entry.outfitId,
    day: entry.day,
    occasion: scheduled.occasion,
    changed: scheduled.outcome === 'scheduled',
    adopted: scheduled.outcome === 'already-scheduled' && scheduled.adopted,
    clientId: clientId?.slice(0, 8),
  });
  return scheduled;
}

/**
 * Undo of a delete (POST /calendar/restore): the entry the server held
 * planned again as it was, the planner's `auto` or the person's.
 */
export async function restoreEntry(
  { db, logger }: ActionDeps,
  actor: Actor,
  removed: RemovedEntry,
): Promise<ScheduledEntry> {
  const { outfitId, day, occasion, plannedBy } = removed;
  const scheduled = await schedule(
    db,
    actor,
    { outfitId, day, occasion },
    plannedBy === 'auto' ? 'planner' : BY_PERSON,
  );
  logOp(logger, actor, 'calendar.entry.restored', {
    entryId: scheduled.entryId,
    outfitId,
    day,
    occasion: scheduled.occasion,
    plannedBy,
  });
  return scheduled;
}

/**
 * Marks the actor's entry worn or not (`worn` undefined toggles), its
 * wears with it (setEntryWorn); 'future' for a day still to come, which
 * each surface refuses its own way (the pill's 409, mark_worn's 400), so
 * it logs nothing here.
 */
export async function markEntryWorn(
  { db, logger }: ActionDeps,
  actor: Actor,
  input: {
    entryId: number;
    worn: boolean | undefined;
    at: Date;
    today: IsoDate;
    tap?: TapInstant | null;
  },
): Promise<Exclude<EntryWornOutcome, 'not-found'>> {
  const outcome = await setEntryWorn(db, { ...input, ownerId: actor.userId });
  if (outcome === 'not-found') throw calendarEntryNotFound();
  if (outcome === 'future') return outcome;
  logOp(logger, actor, 'calendar.entry.worn', {
    entryId: input.entryId,
    day: outcome.day,
    worn: outcome.worn,
    changed: outcome.changed,
    wears: outcome.wears,
  });
  return outcome;
}

/**
 * The actor's entry as the week draws it (findEntry), for a row redrawn
 * alone after its worn write: gone meanwhile (deleted in another tab) is
 * the 404 too.
 */
export async function requireEntry(
  db: Db,
  actor: Actor,
  entry: { id: number; day: IsoDate },
  today: IsoDate,
): Promise<CalendarEntry> {
  const found = await findEntry(db, actor.userId, entry, today);
  if (!found) throw calendarEntryNotFound();
  return found;
}

/**
 * POST /calendar/:id/delete: deletes the actor's entry with its wears,
 * its selfie's row and, for a planner's entry, the outfit "Plan my week"
 * made for it once nothing holds it (deleteEntry, one transaction, Undo's
 * rule: #659), then the selfie's bytes,
 * which no transaction holds (AGENTS.md Gotchas, "The DB cascade deletes
 * rows, never bytes"). Answers what was removed: the page route's Undo
 * restores from it, or 'needs-confirmation' (nothing deleted) when `asksFirst`
 * and Undo could not restore it.
 */
export async function removeEntry(
  { db, photos, logger }: ActionDeps & { photos: Photos },
  actor: Actor,
  id: number,
  { asksFirst = false }: { asksFirst?: boolean } = {},
): Promise<DeletedEntry | 'needs-confirmation'> {
  const outcome = await deleteEntry(db, id, actor.userId, { asksFirst });
  if (outcome === 'not-found') throw calendarEntryNotFound();
  if (outcome === 'needs-confirmation') {
    // Worn, an agent's or taking a one-off outfit: the sheet asks first.
    // A refusal writes no op line (docs/conventions.md#logging).
    return outcome;
  }
  // Only after commit: an unlink cannot be rolled back.
  for (const fileName of outcome.selfies) {
    await photos.deleteVariants(unkeyedPhoto(fileName));
  }
  logOp(logger, actor, 'calendar.entry.deleted', {
    entryId: id,
    changed: true,
    selfies: outcome.selfies,
    oneOffOutfitRemoved: outcome.oneOffRemoved,
  });
  return outcome;
}
