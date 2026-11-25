import type { IsoDate } from '../../calendar-date';
import type { AwayReason } from '../../wardrobe/availability';
import type { Db } from '../../db/client';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { type ActionDeps, logOp } from '../op-log';
import type { Actor } from '../sharing/access';
import { garmentNotOwnedYet } from '../wardrobe/garment-actions';
import {
  type GarmentAddress,
  garmentNotFound,
  garmentWardrobe,
} from '../wardrobe/garment-access';
import { findGarment } from '../wardrobe/queries';
import { markWashed, setAway, setWoreToday, type WashOutcome } from './queries';

/**
 * The wear path (#188, #193a): Wore today, Washed and away on one garment,
 * each taking the Actor and the garment's address and refusing itself, so
 * the garment page (routes.tsx) and the API (api-routes.ts) refuse alike.
 * The owner's own records: a grantee who sees the garment is a 403 through
 * `?ownerId=` and a 404 without it, where it is not in their wardrobe
 * (garmentWardrobe's `own`, free on one's own wardrobe). Each writer
 * judges the garment in its own statement (queries.ts), so a write that
 * lands reads nothing first (#160); only one that changed nothing reads
 * the garment to say why: not the owner's (404) or a wishlist item, not
 * owned yet (409). Callers parse, call and answer; the day is theirs to
 * judge (today, or a queued tap's within the window).
 */

/** A queued wear's client id refused; the page route logs it with the replay's key. */
export class WearClientIdRefusal extends HttpError {
  constructor(readonly outcome: 'gone' | 'client-id-taken') {
    super(
      outcome === 'gone' ? 410 : 409,
      t(outcome === 'gone' ? 'WEAR_DELETED' : 'WEAR_CLIENT_ID_TAKEN'),
    );
  }
}

/** What a wear or wash did, in whose wardrobe (always the actor's own). */
export interface WearWrite {
  ownerId: number;
  /** False for one that already was so: a retry, a replayed tap. */
  changed: boolean;
}

/** Wore it on `day` (worn) or its undo that day, the garment's own day-level wear (setWoreToday). */
export async function wearGarment(
  { db, logger }: ActionDeps,
  actor: Actor,
  address: GarmentAddress,
  change: {
    day: IsoDate;
    worn: boolean;
    /** Its instant on `day`, or null (instantOnDay, #676). */
    wornAt: Date | null;
    clientId?: string;
  },
): Promise<WearWrite> {
  const { access } = await garmentWardrobe(db, actor, address, 'own');
  const outcome = await setWoreToday(db, {
    garmentId: address.id,
    ownerId: access.ownerId,
    ...change,
  });
  if (outcome === 'not-found') throw garmentNotFound();
  if (outcome === 'wishlist') throw garmentNotOwnedYet();
  // A queued wear's client id (#196a): its wear was deleted since (410), or
  // the id names another wear (409).
  if (outcome === 'gone' || outcome === 'client-id-taken') {
    throw new WearClientIdRefusal(outcome);
  }
  const changed = outcome === 'changed';
  logOp(logger, actor, change.worn ? 'garment.worn' : 'garment.wear.undone', {
    garmentId: address.id,
    day: change.day,
    changed,
    clientId: change.clientId,
  });
  return { ownerId: access.ownerId, changed };
}

/**
 * Washed on `day` at `at`, its instant on that day or null (markWashed: a
 * wash never moves back, so an older one is unchanged).
 */
export async function washGarment(
  { db, logger }: ActionDeps,
  actor: Actor,
  address: GarmentAddress,
  wash: { day: IsoDate; at: Date | null },
): Promise<WearWrite> {
  const { access } = await garmentWardrobe(db, actor, address, 'own');
  const {
    washed: [washed],
  } = await markWashed(db, access.ownerId, [address.id], wash.day, wash.at);
  if (!washed) throw await refusalOf(db, address.id, access.ownerId);
  logOp(logger, actor, 'garment.washed', {
    garmentId: address.id,
    day: wash.day,
    changed: washed.changed,
  });
  return { ownerId: access.ownerId, changed: washed.changed };
}

/**
 * Laundry's batch (the laundry page, `POST /garments/washes`, mark_washed,
 * select mode's Mark washed with `closetOnly`): the actor's own garments
 * named, the rest left unwashed and counted by why (WashOutcome).
 */
export async function washGarments(
  { db, logger }: ActionDeps,
  actor: Actor,
  garmentIds: number[],
  wash: { day: IsoDate; at: Date | null },
  options: { closetOnly?: boolean } = {},
): Promise<WashOutcome> {
  const outcome = await markWashed(
    db,
    actor.userId,
    garmentIds,
    wash.day,
    wash.at,
    options,
  );
  logOp(logger, actor, 'garments.washed', {
    day: wash.day,
    washed: outcome.washed.length,
    asked: garmentIds.length,
    ...outcome.skipped,
  });
  return outcome;
}

/** Away (lent, at the repair shop) with a note, or back in the closet (null): setAway. */
export async function putGarmentAway(
  { db, logger }: ActionDeps,
  actor: Actor,
  address: GarmentAddress,
  away: { reason: AwayReason; note: string | null } | null,
): Promise<{ ownerId: number }> {
  const { access } = await garmentWardrobe(db, actor, address, 'own');
  if (!(await setAway(db, access.ownerId, address.id, away))) {
    throw await refusalOf(db, address.id, access.ownerId);
  }
  logOp(logger, actor, 'garment.away.set', {
    garmentId: address.id,
    away: away?.reason ?? null,
  });
  return { ownerId: access.ownerId };
}

/** Why a writer that answers only whether it wrote (markWashed, setAway) wrote nothing. */
async function refusalOf(
  db: Db,
  id: number,
  ownerId: number,
): Promise<HttpError> {
  const garment = await findGarment(db, id, ownerId);
  return garment?.status === 'wishlist'
    ? garmentNotOwnedYet()
    : garmentNotFound();
}
