import { type ActionDeps, logOp } from '../op-log';
import type { Actor } from '../sharing/access';
import {
  addOutfitRule,
  deleteOutfitRule,
  type NewOutfitRule,
  saveStyleProfile,
} from './queries';
import type { StyleProfileFields } from './validation';

/** The style profile's writes (#712): the one place each logs its outcome, whichever door called it. */

export async function saveProfile(
  { db, logger }: ActionDeps,
  actor: Actor,
  fields: StyleProfileFields,
): Promise<void> {
  await saveStyleProfile(db, actor.userId, fields);
  logOp(logger, actor, 'style.profile.saved', {
    styles: fields.styles?.length ?? 0,
    colours: fields.palette?.length ?? 0,
  });
}

/**
 * A rule added, or `'duplicate'` when the actor holds it already
 * (`changed: false`: the page shows it as a refused form, the API as
 * `added: false`).
 */
export async function addRule(
  { db, logger }: ActionDeps,
  actor: Actor,
  rule: NewOutfitRule,
): Promise<number | 'duplicate'> {
  const added = await addOutfitRule(db, actor, rule);
  logOp(logger, actor, 'outfit.rule.added', {
    ruleId: added === 'duplicate' ? null : added,
    kind: rule.kind,
    changed: added !== 'duplicate',
  });
  return added;
}

export async function removeRule(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
): Promise<void> {
  await deleteOutfitRule(db, actor, id);
  logOp(logger, actor, 'outfit.rule.removed', { ruleId: id });
}
