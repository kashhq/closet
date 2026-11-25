import { randomBytes } from 'node:crypto';
import type { IsoDate } from '../../calendar-date';
import type { Occasion } from '../../wardrobe/occasions';
import { occasionLabel } from '../date-labels';
import { t, type Translated } from '../i18n';
import type { DeletedEntry, ScheduledEntry } from './queries';

/**
 * Removing a calendar entry is reversible (#686) when putting it back
 * restores it exactly: nothing but the row went. A worn entry takes its
 * wears and selfie, a one-off outfit (the planner's, an idea's: the row
 * shows its collage, not a name) is pruned with it (#748), and an agent's
 * choice carries a token the restore does not rewrite. Those are asked
 * first, by the confirm sheet; the rest act at once and the toast offers
 * Undo.
 *
 * The rule is `removalAsksFirst` (removal.ts), which the row's hint and the
 * server's decision (deleteEntry's `asksFirst`, from the current row) both
 * call, so a page gone stale never deletes irreversibly unasked.
 */

/** What Undo puts back: the removed entry as the server saw it. */
export interface RemovedEntry {
  outfitId: number;
  day: IsoDate;
  occasion: Occasion;
  plannedBy: 'auto' | 'user';
}

/** The snapshot of a delete that took nothing else with it, else undefined. */
export function restorable(removed: DeletedEntry): RemovedEntry | undefined {
  const { entry } = removed;
  if (entry.worn || removed.oneOffRemoved !== null) return undefined;
  if (entry.plannedBy === 'agent') return undefined;
  return {
    outfitId: entry.outfitId,
    day: entry.day,
    occasion: entry.occasion,
    plannedBy: entry.plannedBy,
  };
}

/**
 * What Undo's toast says (#892): put back, or, when the outfit was planned
 * on that day again since the delete, that it is there already under the
 * occasion it kept (an outfit is on a day once, so the restore inserted
 * nothing, and the day may show it under another occasion).
 */
export function restoredMessage(restored: ScheduledEntry): Translated {
  return restored.outcome === 'scheduled'
    ? t('CALENDAR_RESTORED')
    : t('CALENDAR_ALREADY_PLANNED', {
        occasion: occasionLabel(restored.occasion),
      });
}

/** Longer than the toast shows Undo (toast.js UNDO_TOAST_MS), so a tap in time always finds it. */
const UNDO_TTL_MS = 30_000;

/**
 * The removed entries Undo may restore, held by the server (#686): the
 * restore takes only a random token, never the entry's fields, so a client
 * cannot mint an entry with provenance (the planner's `auto`) it never
 * had. In memory and short-lived: a restart or the TTL just loses Undo.
 * One per app instance. A token is the owner's alone and works once.
 */
export function createUndoStore(now: () => number = Date.now) {
  const held = new Map<
    string,
    { ownerId: number; entry: RemovedEntry; expires: number }
  >();
  return {
    put(ownerId: number, entry: RemovedEntry): string {
      for (const [token, kept] of held) {
        if (kept.expires <= now()) held.delete(token);
      }
      const token = randomBytes(16).toString('base64url');
      held.set(token, { ownerId, entry, expires: now() + UNDO_TTL_MS });
      return token;
    },
    /** Consumes the token: undefined when unknown, expired, used or another owner's. */
    take(ownerId: number, token: string): RemovedEntry | undefined {
      const kept = held.get(token);
      if (kept?.ownerId !== ownerId) return undefined;
      held.delete(token);
      return kept.expires > now() ? kept.entry : undefined;
    },
  };
}
