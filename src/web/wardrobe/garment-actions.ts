import type { MultipartFile } from '@fastify/multipart';
import { type CutoutOutcome, recordCutoutEvent } from '../../cutout/queries';
import { QUANTITY_MAX } from '../../wardrobe/availability';
import type { GarmentStatus } from '../../wardrobe/status';
import type { Queryable } from '../../db/client';
import type { WriteOrigin } from '../write-origin';
import type { GarmentDetail } from './queries';
import { HttpError } from '../errors';
import type { EditedCutout } from '../files/photos';
import { t } from '../i18n';
import { type ActionDeps, logOp } from '../op-log';
import { NotFound } from '../refusals';
import { type ShareableIdAfter, setPublicShare } from '../share/queries';
import type { Actor, AuthorizedWardrobe } from '../sharing/access';
import {
  type AuthorizedGarment,
  type GarmentAddress,
  garmentNotFound,
  garmentWardrobe,
  requireGarment,
} from './garment-access';
import type { ConditionFields, GarmentFields } from './garment-input';
import { type BulkChange, readTags, type TagBody } from './grid-schemas';
import { addCopies } from './lookalikes';
import {
  bulkSetProperty,
  type GarmentPhoto,
  setCondition,
  updateGarmentFields,
  updateGarmentProperties,
} from './queries';
import { addRepair, deleteRepair, type NewRepair } from './repairs';
import { setGarmentStatus, type StatusOutcome } from './status';
import {
  cloneGarment,
  createGarment,
  createGarmentOnce,
  createGarmentWithPendingPhoto,
  removeGarment,
  replacePhoto,
  type RotateDirection,
  rotateGarmentPhoto,
  type SwappedCutout,
  type WardrobeDeps,
  type WithGarment,
} from './writes';

type Db = WardrobeDeps['db'];

/**
 * The garment write path (#188; docs/plans/2026-11-12-json-api.md section
 * 4): every change a surface makes to a garment, each taking the Actor and
 * the address and enforcing access itself, so a page, an MCP tool and the
 * API refuse alike. Who may do what is garment-access.ts's (a MANAGE share
 * or ownership changes a garment; archive, restore, delete and the repair
 * log are the owner's), and each refusal is typed here with a `logDetail`
 * for the request's log line: callers parse, call and render.
 *
 * A page that needs the wardrobe before its write (a form's audience, a
 * refused form drawn again) asks its guard first; the writer's own check is
 * then free (one's own wardrobe, or the share the session read ahead), so
 * statement counts hold. The owner-scoped queries underneath (queries.ts,
 * writes.ts, status.ts) trust their `ownerId`: only this path reaches them
 * from a surface.
 */

const CREATED = 'garment.created';
const STATUS_CHANGED = 'garment.status.changed';

/** What a new garment's line says besides the garment: where it went and what it was for. */
interface CreatedNote {
  destination: 'closet' | 'wishlist';
  replacesGarmentId?: number;
  boughtForNeedId?: number;
  orderItem?: number;
}

/**
 * A new garment in `ownerId`'s wardrobe (createGarment; the caller has
 * authorized the wardrobe), the line `garment.created`.
 */
export async function addGarment(
  deps: WardrobeDeps,
  actor: Actor,
  ownerId: number,
  fields: GarmentFields,
  note: CreatedNote,
  madeBy: WriteOrigin,
  withGarment?: WithGarment,
): Promise<number> {
  const id = await createGarment(
    deps,
    ownerId,
    fields,
    note.destination,
    madeBy,
    withGarment,
  );
  logOp(deps.logger, actor, CREATED, {
    garmentId: id,
    ownerId,
    ...note,
  });
  return id;
}

/**
 * addGarment claiming the actor's pending photo (`fileName`) in the
 * garment's transaction; undefined when it was claimed or evicted meanwhile
 * (nothing written, no line).
 */
export async function addGarmentWithPendingPhoto(
  deps: WardrobeDeps,
  actor: Actor,
  ownerId: number,
  fields: GarmentFields,
  fileName: string,
  note: CreatedNote,
  madeBy: WriteOrigin,
  withGarment?: WithGarment,
): Promise<Awaited<ReturnType<typeof createGarmentWithPendingPhoto>>> {
  const claimed = await createGarmentWithPendingPhoto(
    deps,
    ownerId,
    actor.userId,
    fields,
    fileName,
    note.destination,
    madeBy,
    withGarment,
  );
  if (claimed) {
    logOp(deps.logger, actor, CREATED, {
      garmentId: claimed.id,
      ownerId,
      photo: true,
      ...note,
    });
  }
  return claimed;
}

/** addGarment for the API's retried create (createGarmentOnce): `changed` false for a retry. */
export async function addGarmentOnce(
  deps: WardrobeDeps,
  actor: Actor,
  ownerId: number,
  fields: GarmentFields,
  note: CreatedNote,
  clientId: string,
  settle?: (tx: Queryable) => Promise<WithGarment | undefined>,
): Promise<{ id: number; created: boolean }> {
  const once = await createGarmentOnce(
    deps,
    ownerId,
    fields,
    note.destination,
    clientId,
    settle,
  );
  logOp(deps.logger, actor, CREATED, {
    garmentId: once.id,
    ownerId,
    changed: once.created,
    clientId,
    ...note,
  });
  return once;
}

/** A copy of `source` in the actor's own wardrobe (cloneGarment), the line `garment.cloned`. */
export async function cloneGarmentFor(
  deps: WardrobeDeps,
  actor: Actor,
  source: GarmentDetail,
  fields: GarmentFields,
): Promise<number> {
  const id = await cloneGarment(deps, source, actor.userId, fields);
  logOp(deps.logger, actor, 'garment.cloned', {
    garmentId: id,
    sourceId: source.id,
  });
  return id;
}

/**
 * Select mode's "Set…" over the wardrobe `ownerId` (authorized by the
 * caller: owner or MANAGE): the garments named whose role has the property
 * are set, the rest counted as skipped. No change, or none named, writes
 * nothing (`garments.property.set` with zeros).
 */
export async function bulkSetGarments(
  { db, logger }: ActionDeps,
  actor: Actor,
  ownerId: number,
  ids: number[],
  change: BulkChange | undefined,
): Promise<{ updated: number; skipped: number }> {
  const result =
    change && ids.length > 0
      ? await bulkSetProperty(db, ownerId, ids, change)
      : { updated: 0, skipped: 0 };
  logOp(logger, actor, 'garments.property.set', {
    property: change?.property ?? null,
    ownerId,
    updated: result.updated,
    skipped: result.skipped,
    asked: ids.length,
  });
  return result;
}

/**
 * The edit form's save (every field; a cleared one is null), without
 * reading the garment: the update answers whether it was there (#161).
 */
export async function updateGarment(
  { db, logger }: ActionDeps,
  actor: Actor,
  address: GarmentAddress,
  fields: Partial<GarmentFields>,
): Promise<AuthorizedWardrobe> {
  const wardrobe = await garmentWardrobe(db, actor, address, 'manage');
  if (
    !(await updateGarmentFields(
      db,
      address.id,
      wardrobe.access.ownerId,
      fields,
    ))
  ) {
    throw garmentNotFound();
  }
  logOp(logger, actor, 'garment.updated', {
    garmentId: address.id,
    ownerId: wardrobe.access.ownerId,
  });
  return wardrobe;
}

/**
 * An edit judged against the stored garment (update_garment: only what
 * changed, and what the role keeps): `edit` answers the fields to write,
 * none writing nothing; the answer is the authorized garment as read, with
 * what `edit` answered.
 */
export async function editGarment<
  Edit extends { fields: Partial<GarmentFields> },
>(
  { db, logger }: ActionDeps,
  actor: Actor,
  address: GarmentAddress,
  edit: (stored: AuthorizedGarment) => Edit,
): Promise<AuthorizedGarment & { edit: Edit }> {
  const stored = await requireGarment(db, actor, address, 'manage');
  const edited = edit(stored);
  if (
    Object.keys(edited.fields).length > 0 &&
    !(await updateGarmentFields(
      db,
      address.id,
      stored.access.ownerId,
      edited.fields,
    ))
  ) {
    throw garmentNotFound();
  }
  logOp(logger, actor, 'garment.updated', {
    garmentId: address.id,
    ownerId: stored.access.ownerId,
    fields: Object.keys(edited.fields),
  });
  return { ...stored, edit: edited };
}

/** The garment page's condition control: owner and MANAGE, like any property. */
export async function setGarmentCondition(
  { db, logger }: ActionDeps,
  actor: Actor,
  address: GarmentAddress,
  fields: ConditionFields,
): Promise<AuthorizedWardrobe> {
  const wardrobe = await garmentWardrobe(db, actor, address, 'manage');
  if (!(await setCondition(db, address.id, wardrobe.access.ownerId, fields))) {
    throw garmentNotFound();
  }
  logOp(logger, actor, 'garment.condition.set', {
    garmentId: address.id,
    condition: fields.condition,
    note: Boolean(fields.conditionNote),
  });
  return wardrobe;
}

/**
 * A tagging card's tap (readTags: only what differs from the stored
 * garment, so a post that changes nothing writes nothing); a type the
 * category does not have is a 400. Answers the fields it changed.
 */
export async function tagGarment(
  { db, logger }: ActionDeps,
  actor: Actor,
  address: GarmentAddress,
  tags: Omit<TagBody, 'next'>,
): Promise<AuthorizedGarment & { changed: string[] }> {
  const stored = await requireGarment(db, actor, address, 'manage');
  const changes = readTags(tags, stored.garment);
  if (!changes) throw new HttpError(400, t('refusal.garment.notThisCategory'));
  const changed = Object.keys(changes);
  if (
    changed.length > 0 &&
    !(await updateGarmentProperties(
      db,
      address.id,
      stored.access.ownerId,
      changes,
    ))
  ) {
    throw garmentNotFound();
  }
  // A card left alone (Next posts its checked chips) is no event.
  if (changed.length > 0) {
    logOp(logger, actor, 'garment.tagged', {
      garmentId: address.id,
      fields: changed,
    });
  }
  return { ...stored, changed };
}

/**
 * Share (`shared`) or Stop sharing a garment's public link (#669,
 * setPublicShare): owner and MANAGE, as the ⋯ menu's Share always was, so
 * a link a grantee minted shows on the owner's page with Stop. Answers the
 * link's id after the write. Pages and the API (PUT and DELETE
 * /garments/{id}/share) alike: a Share of a shared garment keeps its id, a
 * Stop of an unshared one writes null again, so both are idempotent.
 */
export async function setGarmentPublicShare<Shared extends boolean>(
  { db, logger }: ActionDeps,
  actor: Actor,
  address: GarmentAddress,
  shared: Shared,
): Promise<AuthorizedWardrobe & { shareableId: ShareableIdAfter<Shared> }> {
  const wardrobe = await garmentWardrobe(db, actor, address, 'manage');
  const written = await setPublicShare(
    db,
    'garment',
    address.id,
    wardrobe.access.ownerId,
    shared,
  );
  if (!written) throw garmentNotFound();
  logOp(logger, actor, 'garment.share.set', {
    garmentId: address.id,
    shared,
  });
  return { ...wardrobe, ...written };
}

/** Archive and Restore's 409 when the garment's status does not take the event. */
const STATUS_REFUSED = {
  archive: 'refusal.status.archive',
  restore: 'refusal.status.restore',
} as const;

/**
 * Archive or Restore, through setGarmentStatus (the one status writer):
 * owner only, even for a MANAGE grantee. Each names its move, so a page
 * that showed another status (another phone, a stale tab) gets a 409, never
 * the opposite move the old archive toggle made.
 */
export async function changeGarmentStatus(
  { db, logger }: ActionDeps,
  actor: Actor,
  address: GarmentAddress,
  event: keyof typeof STATUS_REFUSED,
): Promise<AuthorizedWardrobe & StatusMove> {
  const wardrobe = await garmentWardrobe(db, actor, address, 'own');
  const outcome = await setGarmentStatus(
    db,
    address.id,
    wardrobe.access.ownerId,
    { event },
  );
  if (!outcome.ok) throw statusRefusal(address, event, outcome);
  logOp(logger, actor, STATUS_CHANGED, {
    garmentId: address.id,
    from: outcome.from,
    to: outcome.to,
  });
  return { ...wardrobe, from: outcome.from, to: outcome.to };
}

interface StatusMove {
  from: GarmentStatus;
  to: GarmentStatus;
}

/** The statuses an owned garment is put in by hand ("Bought it" is the wishlist's). */
export const OWNED_STATUSES = ['closet', 'archived'] as const;
export type OwnedStatus = (typeof OWNED_STATUSES)[number];

/** The event that puts a garment in each. */
const EVENT_TO = { archived: 'archive', closet: 'restore' } as const;

/**
 * PUT /garments/{id}/status (#192b): the garment put in `to`, through the
 * same event as Archive or Restore, owner only. Set-state, so a garment
 * already there is answered as moved there (`from` = `to`, nothing
 * written): a client's retry after a lost answer is not a 409. Any other
 * status that does not take the event is Archive's or Restore's 409.
 */
export async function putGarmentStatus(
  { db, logger }: ActionDeps,
  actor: Actor,
  address: GarmentAddress,
  to: OwnedStatus,
): Promise<AuthorizedWardrobe & StatusMove> {
  const wardrobe = await garmentWardrobe(db, actor, address, 'own');
  const event = EVENT_TO[to];
  const outcome = await setGarmentStatus(
    db,
    address.id,
    wardrobe.access.ownerId,
    { event },
  );
  if (outcome.ok) {
    logOp(logger, actor, STATUS_CHANGED, {
      garmentId: address.id,
      from: outcome.from,
      to: outcome.to,
    });
    return { ...wardrobe, from: outcome.from, to: outcome.to };
  }
  if (outcome.reason === 'not-allowed' && outcome.status === to) {
    logOp(logger, actor, STATUS_CHANGED, {
      garmentId: address.id,
      from: to,
      to,
      changed: false,
    });
    return { ...wardrobe, from: to, to };
  }
  throw statusRefusal(address, event, outcome);
}

function statusRefusal(
  address: GarmentAddress,
  event: keyof typeof STATUS_REFUSED,
  outcome: StatusOutcome & { ok: false },
): HttpError {
  if (outcome.reason === 'not-found') return garmentNotFound();
  return new HttpError(409, t(STATUS_REFUSED[event]), {
    logDetail: `garment ${address.id} is ${outcome.status}`,
  });
}

/**
 * Deletes the owner's garment and its photo (removeGarment: the bytes after
 * the rows commit), with no read before it (#161); answers the status it
 * had. A suggestion (#333) is set aside through its decision, never
 * deleted: a 409.
 */
export async function deleteOwnGarment(
  deps: WardrobeDeps,
  actor: Actor,
  address: GarmentAddress,
): Promise<AuthorizedWardrobe & { status: GarmentStatus }> {
  const wardrobe = await garmentWardrobe(deps.db, actor, address, 'own');
  const deleted = await removeGarment(
    deps,
    address.id,
    wardrobe.access.ownerId,
  );
  if (!deleted.ok) {
    if (deleted.reason === 'not-found') throw garmentNotFound();
    throw new HttpError(409, t('wishlist.SUGGESTION_NOT_DELETED'), {
      logDetail: `garment ${address.id} is a suggestion, set aside, never deleted`,
    });
  }
  logOp(deps.logger, actor, 'garment.deleted', {
    garmentId: address.id,
    ownerId: wardrobe.access.ownerId,
    status: deleted.status,
  });
  return { ...wardrobe, status: deleted.status };
}

/**
 * `copies` more of a closet garment (its quantity; addCopies, under the
 * owner lock): owner and MANAGE. A garment not in the closet (a wishlist
 * item, an archived one) and one past QUANTITY_MAX are 409s.
 */
export async function addGarmentCopies(
  { db, logger }: ActionDeps,
  actor: Actor,
  address: GarmentAddress,
  copies: number,
): Promise<AuthorizedWardrobe & { from: number; to: number }> {
  const wardrobe = await garmentWardrobe(db, actor, address, 'manage');
  const outcome = await addCopies(
    db,
    wardrobe.access.ownerId,
    address.id,
    copies,
  );
  if (!outcome.ok) {
    const logDetail = `copies of garment ${address.id}: ${outcome.reason}`;
    if (outcome.reason === 'not-found') {
      throw new NotFound('garment', { logDetail });
    }
    throw new HttpError(
      409,
      outcome.reason === 'too-many'
        ? t('lookalikes.TOO_MANY', { max: QUANTITY_MAX })
        : t('lookalikes.NOT_IN_CLOSET'),
      { logDetail },
    );
  }
  logOp(logger, actor, 'garment.copies.added', {
    garmentId: address.id,
    from: outcome.from,
    to: outcome.to,
  });
  return { ...wardrobe, from: outcome.from, to: outcome.to };
}

/**
 * The garment's photo for a change to it (owner or MANAGE): a garment
 * without one is a 400 (the page offers no such change).
 */
async function photoToChange(
  db: Db,
  actor: Actor,
  address: GarmentAddress,
): Promise<AuthorizedWardrobe & { photo: GarmentPhoto }> {
  const { garment, ...wardrobe } = await requireGarment(
    db,
    actor,
    address,
    'manage',
  );
  if (!garment.photo) throw new HttpError(400, t('refusal.garment.noPhoto'));
  return { ...wardrobe, photo: garment.photo };
}

/**
 * The photo sheet's upload (replacePhoto: stored, queued for its cutout,
 * swapped in). The garment is checked before `parts` is read, so a refused
 * upload stores nothing: `parts` must be lazy (request.files()).
 */
export async function replaceGarmentPhoto(
  deps: WardrobeDeps,
  actor: Actor,
  address: GarmentAddress,
  parts: AsyncIterable<MultipartFile>,
): Promise<AuthorizedWardrobe & { cutoutStatus: SwappedCutout }> {
  const { garment, ...wardrobe } = await requireGarment(
    deps.db,
    actor,
    address,
    'manage',
  );
  const cutoutStatus = await replacePhoto(
    deps,
    garment.id,
    wardrobe.access.ownerId,
    parts,
  );
  return { ...wardrobe, cutoutStatus };
}

/** The photo sheet's quarter turn (rotateGarmentPhoto; a photo changed meanwhile is its 409). */
export async function turnGarmentPhoto(
  deps: WardrobeDeps,
  actor: Actor,
  address: GarmentAddress,
  direction: RotateDirection,
): Promise<AuthorizedWardrobe & { cutoutStatus: SwappedCutout }> {
  const { photo, ...wardrobe } = await photoToChange(deps.db, actor, address);
  const cutoutStatus = await rotateGarmentPhoto(
    deps,
    address.id,
    wardrobe.access.ownerId,
    photo,
    direction,
  );
  return { ...wardrobe, cutoutStatus };
}

/**
 * "Try again" on a failed cutout: the retry event, waking the queue when
 * it took; a cutout that is no longer failed is left alone (its outcome
 * says why), so a second tap is harmless.
 */
export async function retryGarmentCutout(
  deps: Pick<WardrobeDeps, 'db' | 'cutouts' | 'logger'>,
  actor: Actor,
  address: GarmentAddress,
): Promise<AuthorizedWardrobe & { outcome: CutoutOutcome }> {
  const { photo, ...wardrobe } = await photoToChange(deps.db, actor, address);
  // Nothing would run it: the page shows no "Try again" then (shownWithoutCutouts).
  const outcome: CutoutOutcome = deps.cutouts.enabled
    ? await recordCutoutEvent(deps.db, photo.fileName, { type: 'retry' })
    : { ok: false, reason: 'not-allowed' };
  if (outcome.ok) deps.cutouts.wake();
  logOp(deps.logger, actor, 'garment.cutout.requeued', {
    garmentId: address.id,
    changed: outcome.ok,
    reason: outcome.ok ? undefined : outcome.reason,
  });
  return { ...wardrobe, outcome };
}

/**
 * The mask editor's save: the edited cutout replaces the stored one. The
 * garment is checked before `upload` opens the body (request.file(), which
 * starts reading it); no file is a 400, and a photo whose row went since
 * it was read (a delete, a photo replaced) a 404.
 */
export async function saveEditedGarmentCutout(
  deps: Pick<WardrobeDeps, 'db' | 'photos' | 'logger'>,
  actor: Actor,
  address: GarmentAddress,
  upload: () => Promise<MultipartFile | undefined>,
): Promise<EditedCutout> {
  const { photo } = await photoToChange(deps.db, actor, address);
  const part = await upload();
  if (!part) throw new HttpError(400, t('refusal.request.noFile'));
  const edited = await deps.photos.saveEditedCutout(part.file, photo.fileName);
  if (!edited) {
    throw new NotFound('garmentPhoto', {
      logDetail: `photo ${photo.fileName} of garment ${address.id} went while its mask was saved`,
    });
  }
  logOp(deps.logger, actor, 'garment.cutout.replaced', {
    garmentId: address.id,
    version: edited.version,
  });
  return edited;
}

/**
 * The garment the repair log writes to (#23): the owner's own record, like
 * wears, so a grantee is refused (403 through `?ownerId=`, where they can
 * see it; 404 without, where it is not in their wardrobe), and a wishlist
 * item is not owned yet (409). The read a refused entry's form needs.
 */
export async function garmentToMend(
  db: Db,
  actor: Actor,
  address: GarmentAddress,
): Promise<AuthorizedGarment> {
  const owned = await requireGarment(db, actor, address, 'own');
  if (owned.garment.status === 'wishlist') throw garmentNotOwnedYet();
  return owned;
}

/**
 * A wishlist item, seen but not owned yet, where an owner's record needs a
 * garment they have (a repair, a wear, a wash, away: wear-actions.ts): 409.
 */
export function garmentNotOwnedYet(): HttpError {
  return new HttpError(409, t('refusal.garment.notOwnedYet'));
}

/**
 * Logs `entry` on the owner's garment (addRepair, under the owner lock,
 * judges the garment again); the new entry's id. A garment deleted or
 * moved to the wishlist since it was read is a 404.
 */
export async function logRepair(
  { db, logger }: ActionDeps,
  actor: Actor,
  address: GarmentAddress,
  entry: NewRepair,
): Promise<number> {
  const { access } = await garmentWardrobe(db, actor, address, 'own');
  const repairId = await addRepair(db, access.ownerId, address.id, entry);
  if (repairId === undefined) {
    throw new NotFound('garment', {
      logDetail: `garment ${address.id} gone or on the wishlist since it was read`,
    });
  }
  logOp(logger, actor, 'garment.repair.logged', {
    garmentId: address.id,
    repairId,
    kind: entry.kind,
    day: entry.day,
  });
  return repairId;
}

/** Removes entry `repairId` from the owner's garment's log; another garment's entry is a 404. */
export async function removeRepair(
  { db, logger }: ActionDeps,
  actor: Actor,
  address: GarmentAddress,
  repairId: number,
): Promise<void> {
  const { access } = await garmentToMend(db, actor, address);
  if (!(await deleteRepair(db, access.ownerId, address.id, repairId))) {
    throw new NotFound('repair');
  }
  logOp(logger, actor, 'garment.repair.removed', {
    garmentId: address.id,
    repairId,
  });
}
