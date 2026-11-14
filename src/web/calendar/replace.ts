import type { Queryable } from '../../db/client';
import type { OutfitOrigin } from '../../wardrobe/outfit-origin';
import type { Occasion } from '../../wardrobe/occasions';
import { replannable, takesOver } from '../../wardrobe/week';
import { ownerTransaction } from '../auth/queries';
import { HttpError } from '../errors';
import { pickIdea } from '../outfits/pick';
import { t } from '../i18n';
import { garmentsGoneRefusal, goneGarments } from '../outfits/gone-garments';
import { type ActionDeps, logOp } from '../op-log';
import { NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import { detachEntrySelfie } from '../selfies/queries';
import {
  plannerCreatedOutfit,
  removeUnheldOutfits,
} from '../week-plan/queries';
import type { IsoDate } from '../../calendar-date';
import { occasionLabel } from '../date-labels';
import type { WriteOrigin } from '../write-origin';
import { chooserOf } from './planned-by';
import {
  entryOf,
  lockEntryToReplace,
  ownsOutfit,
  setEntryOutfit,
} from './queries';

/**
 * Changing a planned outfit in place (#69): Today's "Change", the calendar
 * row's Change and the plan page, through POST /calendar and the gallery's
 * pick with `replace=` (OutfitDestination), and the MCP tool
 * schedule_outfit's `replaceEntryId`. One entry stays for the occasion; it
 * is never a delete and a new entry.
 *
 * The rules, decided in #69:
 * - **A worn entry is refused** (409): it is the record of what was
 *   worn, and its wears are snapshots of that outfit's garments (#7). The
 *   person adds another outfit to the day instead; Today and the calendar
 *   offer Change only on an unworn entry.
 * - **Its selfie is kept as a look on its day** (detachEntrySelfie): the
 *   photo shows the old outfit, so it must not move to the new one, and
 *   deleting it would lose a record, the #19 rule for a deleted outfit. An
 *   unworn entry has one only when it was unmarked after the photo.
 * - **The choice becomes the person's** (planned_by 'user', setEntryOutfit):
 *   the re-plan and Undo leave it alone (#16). Also when it is the outfit
 *   the entry already had: choosing what the planner chose takes the entry
 *   over (`adopted`), as planning it does (insertEntry).
 * - **An outfit "Plan my week" created for the entry goes** once nothing
 *   holds it (removeUnheldOutfits, Undo's rule), but only while the entry
 *   was still 'auto': one the person took over is theirs.
 * - **The new outfit already on that day** is refused (409, naming its
 *   occasion): an outfit is on a day once (the unique key).
 *
 * Idempotent: everything runs in one transaction under the owner lock
 * (ownerTransaction, which every calendar writer takes), so a double tap's second
 * request waits for the first, finds the entry already holding the outfit
 * (a picked idea resolves to the outfit the first one created) and changes
 * nothing ('unchanged').
 */

/**
 * What the entry gets: a saved outfit of the owner's, or garments (an
 * idea's, Styling's rows) through pickIdea, named `name` when they are not
 * an outfit yet, with `origin` (#659: `idea` for a picked idea, `person`
 * for Styling's composed rows).
 */
export type ReplacementChoice =
  | { outfitId: number }
  | { garmentIds: readonly number[]; name?: string; origin: OutfitOrigin };

export interface EntryTarget {
  entryId: number;
  /** The entry's day, checked when given (the pages and MCP; the API names the entry alone). */
  day?: IsoDate;
  /** The entry's occasion, checked when given (the pages always give it). */
  occasion?: Occasion;
}

/** The entry holds the chosen outfit: changed now, or already (a double tap). */
export interface Replaced {
  outcome: 'replaced' | 'unchanged';
  entryId: number;
  /** The entry's day and occasion, which a replace keeps. */
  day: IsoDate;
  occasion: Occasion;
  outfitId: number;
  previousOutfitId: number;
  /** The outfit existed already: a saved one, or an idea's garments pickIdea found saved. */
  alreadySaved: boolean;
  /** That outfit was one of Muse's proposals the pick made the owner's (#335). */
  adoptedProposal: boolean;
  /** The selfie kept as a look on the day, if the entry had one. */
  selfieDetached?: number;
  /** Planner-made outfits removed with the swap (0 or 1). */
  outfitsRemoved: number;
  /** The entry was the week planner's ('auto') and is now the chooser's. */
  adopted: boolean;
}

/**
 * Changes the actor's entry to the chosen outfit, or throws the refusal
 * with nothing written (#188: every caller answers it alike, logged
 * through its `logDetail`):
 * - not the actor's entry, or not on that day and occasion: NotFound
 *   ('calendarEntry'), like a missing one (ids reveal nothing; entries are
 *   private, so a share never reaches one);
 * - a saved outfit not the actor's: NotFound('outfit');
 * - an idea's garments not all in the actor's closet (a card from before
 *   an archive): OutfitGarmentsGone, named as the refused transaction saw
 *   them (#219: a 409 naming the owner's archived or wishlist ones, else a
 *   404);
 * - a worn entry, or the new outfit already on the day: a 409 saying what
 *   to do instead.
 * What went through is logged once, after commit (`calendar.entry.changed`;
 * `changed` false for the outfit the entry already holds). `db` may be a
 * caller's transaction (a spec's interleave), which the owner lock joins.
 */
export async function replaceEntryOutfit(
  { db, logger }: ActionDeps<Queryable>,
  actor: Actor,
  target: EntryTarget,
  choice: ReplacementChoice,
  madeBy: WriteOrigin,
): Promise<Replaced> {
  const replaced = await replaceInTransaction(
    db,
    actor.userId,
    target,
    choice,
    madeBy,
  );
  logOp(logger, actor, 'calendar.entry.changed', {
    entryId: replaced.entryId,
    day: replaced.day,
    occasion: replaced.occasion,
    outfitId: replaced.outfitId,
    previousOutfitId: replaced.previousOutfitId,
    changed: replaced.outcome === 'replaced',
    outfitCreated: !replaced.alreadySaved,
    adopted: replaced.adopted,
    selfieDetached: replaced.selfieDetached,
    plannerOutfitsRemoved: replaced.outfitsRemoved,
  });
  return replaced;
}

function replaceInTransaction(
  db: Queryable,
  ownerId: number,
  target: EntryTarget,
  choice: ReplacementChoice,
  madeBy: WriteOrigin,
): Promise<Replaced> {
  const refused = (reason: string) =>
    `${entryLabel(target)} not changed for user ${ownerId}: ${reason}`;
  return ownerTransaction(db, ownerId, 'replaceEntryOutfit', async (tx) => {
    const entry = await lockEntryToReplace(tx, ownerId, target);
    if (!entry) {
      throw new NotFound('calendarEntry', {
        logDetail: refused('not their entry there'),
      });
    }
    // Before the choice: a refused replace must not save an idea either.
    if (entry.worn) {
      throw new HttpError(409, t('changeEntry.REFUSED_WORN'), {
        logDetail: refused('it is worn'),
      });
    }
    const chosen = await chosenOutfit(tx, ownerId, choice, madeBy);
    if (!chosen) {
      if ('outfitId' in choice) {
        throw new NotFound('outfit', {
          logDetail: refused('the outfit is not theirs'),
        });
      }
      // Named in the refused transaction, with the entry's context.
      throw garmentsGoneRefusal(
        await goneGarments(tx, ownerId, choice.garmentIds, 'closet'),
        refused('the garments are not in their closet'),
      );
    }
    const result = {
      adopted: replannable(entry.plannedBy),
      entryId: entry.id,
      day: entry.day,
      occasion: entry.occasion,
      outfitId: chosen.id,
      previousOutfitId: entry.outfitId,
      alreadySaved: chosen.alreadySaved,
      adoptedProposal: chosen.adoptedProposal,
    };
    if (chosen.id === entry.outfitId) {
      // The same outfit chosen again takes the entry over only from a
      // lower rank (the agent never takes a person's, planned-by.ts).
      if (takesOver(chooserOf(madeBy).plannedBy, entry.plannedBy)) {
        await setEntryOutfit(tx, entry.id, chosen.id, madeBy);
      }
      return { outcome: 'unchanged', ...result, outfitsRemoved: 0 };
    }
    // Only an outfit that already existed can be on the day: a created one
    // is new. Nothing was written yet, so refusing needs no rollback.
    const onDay = await entryOf(tx, ownerId, entry.day, chosen.id);
    if (onDay) {
      throw new HttpError(
        409,
        t('changeEntry.REFUSED_ON_DAY', {
          occasion: occasionLabel(onDay.occasion),
        }),
        {
          logDetail: refused(
            `outfit ${chosen.id} is already on the day (${onDay.occasion})`,
          ),
        },
      );
    }
    const plannerMade =
      result.adopted && (await plannerCreatedOutfit(tx, entry.id));
    await setEntryOutfit(tx, entry.id, chosen.id, madeBy, !chosen.alreadySaved);
    const selfieDetached = await detachEntrySelfie(tx, entry.id);
    const outfitsRemoved = plannerMade
      ? await removeUnheldOutfits(tx, ownerId, [entry.outfitId])
      : 0;
    return { outcome: 'replaced', ...result, selfieDetached, outfitsRemoved };
  });
}

async function chosenOutfit(
  tx: Queryable,
  ownerId: number,
  choice: ReplacementChoice,
  madeBy: WriteOrigin,
): Promise<
  { id: number; alreadySaved: boolean; adoptedProposal: boolean } | undefined
> {
  if ('outfitId' in choice) {
    return (await ownsOutfit(tx, ownerId, choice.outfitId))
      ? { id: choice.outfitId, alreadySaved: true, adoptedProposal: false }
      : undefined;
  }
  // No plan: the entry is changed below, not added.
  const picked = await pickIdea(tx, ownerId, {
    garmentIds: choice.garmentIds,
    name: choice.name,
    origin: choice.origin,
    madeBy,
  });
  return picked === 'not-found' ? undefined : picked;
}

/** The entry a refusal's logDetail names: `Calendar entry 12 (2026-11-14 work)`, or bare without a day. */
function entryLabel(target: EntryTarget): string {
  const named = [target.day, target.occasion].filter(Boolean).join(' ');
  return `Calendar entry ${target.entryId}${named ? ` (${named})` : ''}`;
}
