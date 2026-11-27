import type { IsoDate } from '../../calendar-date';
import type { AwayReason } from '../../wardrobe/availability';
import type { Db } from '../../db/client';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { type ActionDeps, logOp } from '../op-log';
import {
  type Actor,
  type AuthorizedWardrobe,
  authorizeWardrobe,
} from '../sharing/access';
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
 * and the laundry's batch, each taking the Actor and the wardrobe's
 * address and refusing itself, so the pages (routes.tsx, the grid's Mark
 * washed), the API (api-routes.ts) and MCP refuse alike. Wore today and
 * the washes need `launder` (#680: the owner and a MANAGE partner, who
 * does the household's laundry); away is the owner's record (`own`). A
 * grantee without it who sees the garment is a 403 through `?ownerId=`,
 * and a 404 without it, where it is not in their wardrobe (garmentWardrobe,
 * free on one's own wardrobe and on the share a request read ahead).
 * A partner's wear or wash is the owner's row, under the owner's lock: the
 * writers take the authorized `ownerId`, never the actor's, and no column
 * says who tapped (the log line does: logOp's actor).
 *
 * Each writer judges the garment in its own statement (queries.ts), so a
 * write that lands reads nothing first (#160); only one that changed
 * nothing reads the garment to say why: not in the wardrobe (404) or a
 * wishlist item, not owned yet (409). Callers parse, call and answer; the
 * day is theirs to judge (today, or a queued tap's within the window).
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

/** What a wear or wash did, in the wardrobe it was authorized in (the owner's, or a MANAGE share). */
export interface WearWrite {
  wardrobe: AuthorizedWardrobe;
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
  const wardrobe = await garmentWardrobe(db, actor, address, 'launder');
  const { access } = wardrobe;
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
    ownerId: access.ownerId,
    day: change.day,
    changed,
    clientId: change.clientId,
  });
  return { wardrobe, changed };
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
  const wardrobe = await garmentWardrobe(db, actor, address, 'launder');
  const { access } = wardrobe;
  const {
    washed: [washed],
  } = await markWashed(db, access.ownerId, [address.id], wash.day, wash.at);
  if (!washed) throw await refusalOf(db, address.id, access.ownerId);
  logOp(logger, actor, 'garment.washed', {
    garmentId: address.id,
    ownerId: access.ownerId,
    day: wash.day,
    changed: washed.changed,
  });
  return { wardrobe, changed: washed.changed };
}

/**
 * Laundry's batch (the laundry page, `POST /garments/washes`, mark_washed,
 * select mode's Mark washed with `closetOnly`) in the wardrobe `ownerId`
 * names (`''` or absent: the actor's own; an unseen one is "Wardrobe not
 * found"): its garments named, the rest left unwashed and counted by why
 * (WashOutcome).
 */
export async function washGarments(
  { db, logger }: ActionDeps,
  actor: Actor,
  ownerId: number | '' | undefined,
  garmentIds: number[],
  wash: { day: IsoDate; at: Date | null },
  options: { closetOnly?: boolean } = {},
): Promise<WashOutcome> {
  const { access } = await authorizeWardrobe(
    db,
    actor,
    ownerId,
    'launder',
    'wardrobe',
  );
  const outcome = await markWashed(
    db,
    access.ownerId,
    garmentIds,
    wash.day,
    wash.at,
    options,
  );
  logOp(logger, actor, 'garments.washed', {
    ownerId: access.ownerId,
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
  const garment = await findGarment(db, id, { ownerId, role: 'OWN' });
  return garment?.status === 'wishlist'
    ? garmentNotOwnedYet()
    : garmentNotFound();
}
