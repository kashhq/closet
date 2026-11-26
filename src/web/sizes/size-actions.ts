import {
  type LengthUnit,
  MEASUREMENTS,
  type Measurements,
} from '../../wardrobe/measurements';
import { type ActionDeps, logOp } from '../op-log';
import type { Actor } from '../sharing/access';
import {
  addBrandSize,
  addBrandSizeOnce,
  deleteBrandSize,
  saveMeasurements,
  setLengthUnit,
  updateBrandSize,
} from './queries';
import type { BrandSizeFields } from './validation';

/**
 * Sizes' writes (#712): the one place each logs its outcome, whichever door
 * called it (the editor, `/api/v1`). A brand's name and size are what the
 * person typed, so no field carries them.
 */

export async function saveBodyMeasurements(
  { db, logger }: ActionDeps,
  actor: Actor,
  lengths: Measurements,
): Promise<void> {
  await saveMeasurements(db, actor.userId, lengths);
  logOp(logger, actor, 'measurements.saved', {
    set: MEASUREMENTS.filter((m) => lengths[m] !== null).length,
    of: MEASUREMENTS.length,
  });
}

export async function setBodyLengthUnit(
  { db, logger }: ActionDeps,
  actor: Actor,
  unit: LengthUnit,
): Promise<void> {
  await setLengthUnit(db, actor.userId, unit);
  logOp(logger, actor, 'measurements.unit.set', { unit });
}

export async function createBrandSize(
  { db, logger }: ActionDeps,
  actor: Actor,
  fields: BrandSizeFields,
): Promise<Awaited<ReturnType<typeof addBrandSize>>> {
  const id = await addBrandSize(db, actor.userId, fields);
  if (typeof id === 'number') {
    logOp(logger, actor, 'brand.size.added', { brandSizeId: id });
  }
  return id;
}

/** createBrandSize for the API's retried create: `changed` false for a retry. */
export async function createBrandSizeOnce(
  { db, logger }: ActionDeps,
  actor: Actor,
  fields: BrandSizeFields,
  clientId: string,
): Promise<Awaited<ReturnType<typeof addBrandSizeOnce>>> {
  const added = await addBrandSizeOnce(db, actor.userId, fields, clientId);
  if (typeof added === 'object') {
    logOp(logger, actor, 'brand.size.added', {
      brandSizeId: added.row.id,
      changed: added.created,
      clientId,
    });
  }
  return added;
}

export async function changeBrandSize(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
  fields: BrandSizeFields,
): Promise<Awaited<ReturnType<typeof updateBrandSize>>> {
  const updated = await updateBrandSize(db, actor, id, fields);
  if (updated === 'updated') {
    logOp(logger, actor, 'brand.size.changed', { brandSizeId: id });
  }
  return updated;
}

export async function removeBrandSize(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
): Promise<void> {
  await deleteBrandSize(db, actor, id);
  logOp(logger, actor, 'brand.size.removed', { brandSizeId: id });
}
